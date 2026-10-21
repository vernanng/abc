// Harness service (Mac proof host): webhook ingress -> triage (Phase B) and
// Phase C jobs: worker in a worktree -> draft branch -> reviewer critique +
// deterministic classifier -> PR with intent packet -> squash-merge only on
// a human's GitHub approval. The service, never a model, does git/GitHub.
//   npm run build && node dist/service.js     (listens on PORT, default 8971)
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, Harness, type Conversation, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import { classify, type ChangedFile } from "./classify.js";
import { GitHubApp } from "./github.js";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
};
const ctx = BACKGROUND_CONTEXT;

// Single-owner lock (library does not enforce it; see SPEC status line).
// A kill -9 leaves the lock behind: yield only when the recorded PID is dead.
const storagePath = process.env.ABC_STORAGE_PATH ?? "./agent.sqlite";
const lockPath = `${storagePath}.lock`;
function acquireLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) throw new Error(`Storage locked by live process ${pid}: ${path}`);
      rmSync(path, { force: true }); // stale lock from a crashed process
    }
  }
  throw new Error(`Could not acquire storage lock: ${path}`);
}
acquireLock(lockPath);

const github = new GitHubApp({
  appId: required("GITHUB_APP_ID"),
  privateKeyPath: required("GITHUB_PRIVATE_KEY_PATH"),
  webhookSecret: required("WEBHOOK_SECRET"),
  repo: required("REPO"),
});

const models = createModels();
models.setProvider(openrouterProvider());
const registry = createRegistry();
registry.install(CodingTools);
const harness: Harness = await Harness.open(await openNodeSqliteStorage(storagePath), {
  models,
  registry,
  env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
  settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 3 } },
}, ctx);
harness.resume();
const triage: Conversation = await harness.root(ctx, {
  agent: { model: { provider: "openrouter", modelId: required("TRIAGE_MODEL") }, cwd: process.cwd() },
});
await triage.configure({
  instructions:
    "You are a triage bot. Classify the GitHub issue as exactly one of: bug, feature, question. " +
    "Reply with one line: 'Triage: <label> — <one short reason>'. Do not use any tools.",
  tools: [],
}, ctx);

const workerModel = required("WORKER_MODEL");
const reviewerModel = required("REVIEWER_MODEL");
const repoSlug = required("REPO");
const repoRoot = process.cwd();
const worktreeRoot = process.env.ABC_WORKTREE_ROOT ?? "./worktrees";

async function answerText(conversation: Conversation, answerId: EntryId): Promise<string> {
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answerId), ctx);
  const message = entry?.model?.[0];
  if (message === undefined || message.role !== "assistant") return "(no answer)";
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

interface IssuePayload {
  action?: string;
  issue?: { number: number; title?: string; body?: string | null; author_association?: string; pull_request?: unknown };
  comment?: { body?: string; author_association?: string };
  review?: { state?: string; user?: { login?: string }; author_association?: string };
  pull_request?: { number?: number };
  sender?: { login?: string };
}

const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Durable delivery journal: the webhook ACKs as soon as a record is on disk
// (GitHub allows 10s; a triage takes longer). A sweeper re-drives unposted
// records, so a crash mid-triage loses nothing and GitHub never has to
// redeliver. The comment marker on GitHub is the final dedupe.
interface DeliveryRecord {
  delivery: string;
  kind?: "triage" | "job" | "review" | "cifail"; // absent in old journal entries = triage
  issueNumber: number;
  title: string;
  body: string;
  commentBody: string;
  association: string;
  login: string;
  posted: boolean;
  attempts?: number;
  // Phase C job state (kind "job"); every step is journaled so a restart
  // resumes instead of restarting, and re-drives never open a second PR.
  workerConversationId?: string;
  reviewerConversationId?: string;
  branch?: string;
  prNumber?: number;
  jobStatus?: string; // working | pr-open | merged | no-changes | failed
  approvalBy?: string; // first write wins (SPEC 6.1)
  resolveAttempts?: number;
  // Phase D (kind "cifail"): a red post-merge CI run on main being healed.
  headSha?: string;
  detectedAt?: number;
  revertPrNumber?: number;
}
const journalPath = `${storagePath}.deliveries.json`;
const journal: DeliveryRecord[] = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as DeliveryRecord[])
  : [];
let onJournalChange: () => void = () => {};
function saveJournal(): void {
  writeFileSync(journalPath, JSON.stringify(journal));
  onJournalChange(); // live console: journal is the state the UI renders
}
function recordDelivery(record: DeliveryRecord): boolean {
  if (journal.some((existing) => existing.delivery === record.delivery)) return false;
  journal.push(record);
  saveJournal();
  return true;
}
function markPosted(delivery: string): void {
  const record = journal.find((existing) => existing.delivery === delivery);
  if (record !== undefined && !record.posted) {
    record.posted = true;
    saveJournal();
  }
}

function toRecord(event: string, delivery: string, payload: IssuePayload): DeliveryRecord | undefined {
  if (event === "pull_request_review" && payload.action === "submitted" && payload.review?.state === "approved") {
    const prNumber = payload.pull_request?.number;
    if (prNumber === undefined) return undefined;
    return {
      delivery,
      kind: "review",
      issueNumber: prNumber,
      title: "",
      body: "",
      commentBody: "",
      association: payload.review.author_association ?? "",
      login: payload.review.user?.login ?? "",
      posted: false,
      prNumber,
    };
  }
  // Our own bot's posts (e.g. the self-healing issue) are not instructions.
  if ((event === "issues" || event === "issue_comment") && (payload.sender?.login ?? "").endsWith("[bot]")) {
    return undefined;
  }
  const isIssueOpen = event === "issues" && payload.action === "opened";
  const isAgentComment =
    event === "issue_comment" &&
    payload.action === "created" &&
    payload.issue?.pull_request === undefined &&
    (payload.comment?.body ?? "").includes("@agent");
  if ((!isIssueOpen && !isAgentComment) || payload.issue === undefined) return undefined;
  // An explicit @agent instruction is a Phase C job; a plain new issue is triage.
  const isJob = isAgentComment || (payload.issue.body ?? "").includes("@agent");
  return {
    delivery,
    kind: isJob ? "job" : "triage",
    issueNumber: payload.issue.number,
    title: payload.issue.title ?? "",
    body: payload.issue.body ?? "",
    commentBody: isAgentComment ? (payload.comment?.body ?? "") : "",
    association: (isAgentComment ? payload.comment?.author_association : payload.issue.author_association) ?? "",
    login: payload.sender?.login ?? "",
    posted: false,
  };
}

async function driveTriage(record: DeliveryRecord): Promise<string> {
  const marker = `<!-- abc-agent:${record.delivery} -->`;
  if (!ASSOCIATIONS.has(record.association) && !(record.login && (await github.isCollaborator(record.login)))) {
    if (!(await github.findCommentWithMarker(record.issueNumber, marker))) {
      await github.postComment(record.issueNumber, `${marker}\nOnly repo collaborators can instruct the agent.`);
    }
    markPosted(record.delivery);
    return "refused-non-collaborator";
  }
  if (await github.findCommentWithMarker(record.issueNumber, marker)) {
    markPosted(record.delivery);
    return "already-commented";
  }
  const content =
    `GitHub issue #${record.issueNumber}: ${record.title}\n\n${record.body}` +
    (record.commentBody ? `\n\nTriggering comment: ${record.commentBody}` : "");
  // A terminal-unanswered submission can never be re-driven under the same
  // requestId (exactly-once). Retry as a fresh submission under a derived id;
  // the GitHub comment marker still guarantees one visible comment.
  let answer: string | undefined;
  for (let attempt = record.attempts ?? 0; attempt <= 3; attempt++) {
    const requestId = attempt === 0 ? record.delivery : `${record.delivery}#${attempt}`;
    const submission = await triage.submit({ type: "input", content, requestId }, ctx);
    const settled = await submission.wait(ctx);
    if (settled.type === "input" && settled.status === "done") {
      answer = await answerText(triage, settled.answer);
      break;
    }
    console.log(`drive delivery=${record.delivery} attempt=${attempt} unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
    record.attempts = attempt + 1;
    saveJournal();
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (answer === undefined) {
    if (!(await github.findCommentWithMarker(record.issueNumber, marker))) {
      await github.postComment(record.issueNumber, `${marker}\nTriage failed after retries (model unavailable). A human should look at this issue.`);
    }
    markPosted(record.delivery);
    return "failed-after-retries";
  }
  if (!(await github.findCommentWithMarker(record.issueNumber, marker))) {
    await github.postComment(record.issueNumber, `${marker}\n${answer || "Triage: question — no classification produced."}`);
  }
  markPosted(record.delivery);
  return "triaged";
}

// --- Phase C: jobs -------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 180_000 }).toString();
}

// Service-side push with the App token; the token never reaches a model and
// is never logged (errors are sanitized to a fixed message).
async function pushBranch(wt: string, branch: string): Promise<void> {
  const token = await github.installationToken();
  try {
    execFileSync("git", ["push", `https://x-access-token:${token}@github.com/${repoSlug}.git`, branch], {
      cwd: wt,
      stdio: "pipe",
      timeout: 180_000,
    });
  } catch {
    throw new Error("git push of draft branch failed");
  }
}

async function sessionCostUsd(): Promise<number> {
  const usage = await harness.usage(ctx);
  let total = 0;
  for (const entry of Object.values(usage.models)) {
    total += (entry as { cost?: { total?: number } }).cost?.total ?? 0;
  }
  return total;
}

async function authorized(record: DeliveryRecord): Promise<boolean> {
  return ASSOCIATIONS.has(record.association) || (record.login !== "" && (await github.isCollaborator(record.login)));
}

// One model role run with derived-requestId retries (a terminal-unanswered
// submission is never re-driven under its original id). Fresh conversation
// per attempt; git state, not the transcript, carries job progress.
async function runRole(options: {
  model: string;
  cwd: string;
  instructions: string;
  readOnly?: boolean;
  content: string;
  requestId: string;
  onConversation?: (id: string) => void;
}): Promise<string | undefined> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "openrouter", modelId: options.model }, cwd: options.cwd },
      },
      ctx,
    );
    options.onConversation?.(String(conversation.id));
    await conversation.configure(
      {
        instructions: options.instructions,
        ...(options.readOnly ? { tools: [createReadTool()] } : {}),
      },
      ctx,
    );
    const requestId = attempt === 0 ? options.requestId : `${options.requestId}#${attempt}`;
    const settled = await (await conversation.submit({ type: "input", content: options.content, requestId }, ctx)).wait(ctx);
    if (settled.type === "input" && settled.status === "done") return answerText(conversation, settled.answer);
    console.log(
      `role ${options.requestId} attempt=${attempt} unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`,
    );
  }
  return undefined;
}

async function tryMerge(job: DeliveryRecord): Promise<string> {
  if (job.prNumber === undefined) return "no-pr";
  if (job.jobStatus === "merged") return "already-merged";
  // The approval memo is first-write-wins and survives pushes (SPEC: no
  // re-review on landing conflicts); GitHub's review state is the fallback
  // for approvals recorded before this journal existed.
  const reviews = await github.listReviews(job.prNumber);
  let approver =
    job.approvalBy ??
    reviews.find(
      (review) => review.state === "APPROVED" && !review.login.endsWith("[bot]") && ASSOCIATIONS.has(review.association),
    )?.login;
  if (approver === undefined) {
    for (const review of reviews) {
      if (review.state === "APPROVED" && review.login && !review.login.endsWith("[bot]") && (await github.isCollaborator(review.login))) {
        approver = review.login;
        break;
      }
    }
  }
  if (approver === undefined) return "awaiting-approval";
  if (job.approvalBy === undefined) {
    job.approvalBy = approver; // approvals are memos: first write wins
    saveJournal();
  }
  try {
    await github.mergePull(job.prNumber);
  } catch (error) {
    // GitHub enforces what we must not bypass (e.g. CODEOWNERS on sensitive
    // paths): stay pr-open and let the sweeper retry on the next approval.
    console.log(`merge PR #${job.prNumber} blocked: ${String(error).slice(0, 200)}`);
    return "merge-blocked";
  }
  job.jobStatus = "merged";
  saveJournal();
  markPosted(job.delivery);
  await github
    .postComment(job.prNumber, `Landed (squash) on intent approval by @${job.approvalBy}. Post-merge CI is the gate (SPEC 6.1).`)
    .catch(() => undefined);
  if (job.branch !== undefined) {
    const wt = join(repoRoot, worktreeRoot, job.branch.replace(/^agent\//, ""));
    try {
      git(repoRoot, "worktree", "remove", "--force", wt);
      git(repoRoot, "branch", "-D", job.branch);
    } catch {
      // worktree cleanup is best-effort; the branch is already deleted on GitHub
    }
  }
  return "merged";
}

async function driveJob(record: DeliveryRecord): Promise<string> {
  const marker = `<!-- abc-agent:${record.delivery} -->`;
  if (record.jobStatus === "merged") {
    markPosted(record.delivery);
    return "already-merged";
  }
  if (record.prNumber !== undefined) {
    // Existing PR (incl. system records like auto-reverts): merge when a
    // human approval exists; if GitHub reports a conflict, the worker
    // conversation resolves it — never a merge queue (SPEC Phase D).
    const pull = await github.getPull(record.prNumber);
    if (!pull.merged && pull.state === "closed") {
      record.jobStatus = "closed";
      markPosted(record.delivery);
      return "pr-closed";
    }
    const result = await tryMerge(record);
    if (result === "merge-blocked" && record.approvalBy !== undefined && (record.resolveAttempts ?? 0) < 2) {
      if (!pull.merged && pull.mergeable === false) {
        await resolveConflict(record);
        return "conflict-resolution-pushed";
      }
    }
    return result;
  }
  if (!(await authorized(record))) {
    if (!(await github.findCommentWithMarker(record.issueNumber, marker))) {
      await github.postComment(record.issueNumber, `${marker}\nOnly repo collaborators can instruct the agent.`);
    }
    record.jobStatus = "failed";
    markPosted(record.delivery);
    return "refused-non-collaborator";
  }
  const jobId = `issue-${record.issueNumber}-${record.delivery.slice(0, 8)}`;
  const branch = (record.branch ??= `agent/${jobId}`);
  if (record.prNumber === undefined) {
    record.jobStatus = "working";
    saveJournal();
    const instruction =
      `GitHub issue #${record.issueNumber}: ${record.title}\n\n${record.body}` +
      (record.commentBody ? `\n\nTriggering comment: ${record.commentBody}` : "");
    const wt = join(repoRoot, worktreeRoot, jobId);
    mkdirSync(join(repoRoot, worktreeRoot), { recursive: true });
    git(repoRoot, "fetch", "origin", "main");
    if (!existsSync(wt)) {
      try {
        git(repoRoot, "worktree", "add", "-b", branch, wt, "origin/main");
      } catch {
        git(repoRoot, "worktree", "add", wt, branch); // resume: branch already exists
      }
    }
    const costBefore = await sessionCostUsd();
    const workerText = await runRole({
      model: workerModel,
      cwd: wt,
      instructions:
        "You are a coding worker in a dedicated git worktree. Never run git or gh; the service handles git and GitHub. " +
        "Keep the change minimal, ship tests for code changes when a test setup exists, run the build/tests you can.",
      content:
        `${instruction}\n\nFirst write a short plan (3-6 bullets), then implement it. ` +
        "End your reply with exactly these sections:\nPlan: ...\nSummary: ...\nTests: ...",
      requestId: `${record.delivery}:worker`,
      onConversation: (id) => {
        record.workerConversationId = id;
        saveJournal();
      },
    });
    if (workerText === undefined) {
      record.jobStatus = "failed";
      markPosted(record.delivery);
      await github.postComment(record.issueNumber, `${marker}\nAgent job failed after retries (worker model unavailable).`);
      return "worker-failed";
    }
    // Budget guard (C9): a job that overspends is parked for a human before
    // anything is committed or pushed.
    const spent = (await sessionCostUsd()) - costBefore;
    const budget = Number(process.env.BUDGET_PER_JOB_USD ?? "2");
    if (spent > budget) {
      record.jobStatus = "parked";
      markPosted(record.delivery);
      await github.postComment(
        record.issueNumber,
        `${marker}\nJob parked: worker spend $${spent.toFixed(4)} exceeded the per-job budget $${budget}. ` +
          `No PR was opened; the worktree is kept locally. A human can raise BUDGET_PER_JOB_USD and re-instruct.`,
      );
      return "parked-budget";
    }
    git(wt, "add", "-A");
    const changed = git(wt, "status", "--porcelain").trim();
    const ahead = git(wt, "rev-list", "--count", "origin/main..HEAD").trim();
    if (changed === "" && ahead === "0") {
      record.jobStatus = "no-changes";
      markPosted(record.delivery);
      await github.postComment(record.issueNumber, `${marker}\nAgent ran but produced no changes.\n\n${workerText.slice(0, 1000)}`);
      return "no-changes";
    }
    if (changed !== "") {
      git(wt, "-c", "user.name=abc-agent", "-c", "user.email=abc-agent@localhost", "commit", "-qm",
        `Agent job for issue #${record.issueNumber}: ${record.title}`.slice(0, 200));
    }
    let testEvidence = "No package.json in worktree; no build run.";
    if (existsSync(join(wt, "package.json"))) {
      try {
        execFileSync("npm", ["run", "build"], { cwd: wt, stdio: "pipe", timeout: 300_000 });
        testEvidence = "`npm run build` (tsc) passed.";
      } catch (error) {
        const tail = String((error as { stdout?: Buffer }).stdout ?? "").split("\n").slice(-15).join("\n");
        testEvidence = `\`npm run build\` FAILED (advisory evidence; landing is gated on intent, not CI):\n\`\`\`\n${tail}\n\`\`\``;
      }
    }
    const files: ChangedFile[] = [];
    for (const line of git(wt, "diff", "--name-status", "origin/main...HEAD").split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      files.push({ path: parts[parts.length - 1] ?? line, status: (parts[0] ?? "M").charAt(0) });
      if (parts.length > 2) files.push({ path: parts[1] ?? "", status: "R" }); // renames: check both paths
    }
    const diff = git(wt, "diff", "origin/main...HEAD");
    const result = classify(files, diff);
    const critique =
      (await runRole({
        model: reviewerModel,
        cwd: wt,
        readOnly: true,
        instructions:
          "You are an adversarial, read-only reviewer. Critique only: constraint violations, over-engineering, " +
          "missing tests, and risks. Short bullets. If the change touches code (non-doc files) and adds no test " +
          "files (or no simulation/fuzz cases for infra-like changes), one bullet MUST start with 'Missing tests:'.",
        content:
          `Review this change for GitHub issue #${record.issueNumber}.\nFiles changed:\n` +
          `${files.map((file) => `- ${file.path}`).join("\n")}\nClassifier: level=${result.level} labels=${result.labels.join(",") || "none"}\n` +
          `Diff (truncated):\n\`\`\`diff\n${diff.slice(0, 12_000)}\n\`\`\``,
        requestId: `${record.delivery}:reviewer`,
        onConversation: (id) => {
          record.reviewerConversationId = id;
          saveJournal();
        },
      })) ?? "(reviewer produced no critique)";
    await pushBranch(wt, branch);
    const packet = [
      `## Intent packet — issue #${record.issueNumber}`,
      `### Instruction\n${instruction.slice(0, 2000)}`,
      `### Plan & worker summary (worker: \`${workerModel}\`)\n${workerText.slice(0, 4000)}`,
      `### Risk classifier (deterministic, final diff)\nLevel: **${result.level}** · Labels: ${result.labels.join(", ") || "none"}\n` +
        `${result.reasons.map((reason) => `- ${reason}`).join("\n")}\nFiles changed:\n${files.map((file) => `- \`${file.path}\` (${file.status})`).join("\n")}`,
      `### Reviewer critique (\`${reviewerModel}\`, read-only, never approves)\n${critique.slice(0, 4000)}`,
      `### Test evidence\n${testEvidence}`,
      `---\nLanding = a human's intent approval on this PR (squash-merge, no CI gate, SPEC 6.1).`,
    ].join("\n\n");
    let prNumber = await github.findOpenPull(branch);
    if (prNumber === undefined) {
      prNumber = (await github.createPull(`[agent] ${record.title}`.slice(0, 120), branch, "main", packet)).number;
    }
    record.prNumber = prNumber;
    record.jobStatus = "pr-open";
    saveJournal();
    if (!(await github.findCommentWithMarker(record.issueNumber, marker))) {
      await github.postComment(
        record.issueNumber,
        `${marker}\nAgent opened PR #${prNumber} for intent review (worker \`${workerModel}\`, reviewer \`${reviewerModel}\`, classifier level **${result.level}**).`,
      );
    }
  }
  return tryMerge(record);
}

// Landing conflicts are fixed by the worker conversation, never a queue:
// merge origin/main into the PR branch in its worktree; only conflicted
// files go to the worker model, then the service commits and pushes.
async function resolveConflict(job: DeliveryRecord): Promise<void> {
  const jobId = (job.branch ?? "").replace(/^agent\//, "").replace(/^revert\//, "");
  const wt = join(repoRoot, worktreeRoot, jobId);
  job.resolveAttempts = (job.resolveAttempts ?? 0) + 1;
  saveJournal();
  git(repoRoot, "fetch", "origin", "main");
  if (!existsSync(wt)) git(repoRoot, "worktree", "add", wt, job.branch ?? "");
  try {
    git(wt, "merge", "origin/main", "--no-edit");
  } catch {
    // conflicted merge in progress; resolved below
  }
  const gitDir = git(wt, "rev-parse", "--absolute-git-dir").trim();
  if (existsSync(join(gitDir, "MERGE_HEAD"))) {
    const text = await runRole({
      model: workerModel,
      cwd: wt,
      instructions:
        "You resolve merge conflicts in a dedicated git worktree. Never run git or gh; just edit the conflicted files. " +
        "Remove all conflict markers, keep both sides' intent where possible, keep it minimal.",
      content:
        "A merge of origin/main into this branch is in progress and has conflicts. " +
        "Find the conflicted files (they contain <<<<<<< markers), resolve them, and reply with what you kept.",
      requestId: `${job.delivery}:resolve${job.resolveAttempts}`,
    });
    if (text === undefined) throw new Error("conflict resolution failed (worker unavailable)");
    git(wt, "add", "-A");
    git(wt, "-c", "user.name=abc-agent", "-c", "user.email=abc-agent@localhost", "commit", "--no-edit");
  }
  if (job.branch !== undefined) await pushBranch(wt, job.branch);
}

async function driveReview(record: DeliveryRecord): Promise<string> {
  const job = journal.find((existing) => existing.kind === "job" && existing.prNumber === record.prNumber);
  markPosted(record.delivery);
  if (job === undefined) return "no-job-for-review";
  // Worker/reviewer (bot) approvals never count; only humans land changes.
  if (record.login.endsWith("[bot]")) return "approval-ignored-bot";
  if (!(await authorized(record))) return "approval-ignored-non-collaborator";
  if (job.approvalBy === undefined) {
    job.approvalBy = record.login;
    saveJournal();
  }
  return tryMerge(job);
}

// --- Phase D: post-merge self-healing ------------------------------------
// The sweeper polls main's CI (the real gate, SPEC 6.1). A red run opens a
// fix issue + fix job (fix forwards); if main is still red after the window
// (ABC_REVERT_AFTER_MINUTES, default 30), a git-only revert PR with reasons
// is opened. Both land through the same human intent approval as any PR.
// System journal records (login "abc-agent-system") are created by the
// service itself, never from webhook input, and skip instruction auth.

async function createRevert(record: DeliveryRecord): Promise<string> {
  const sha = record.headSha ?? "";
  const branch = `revert/${sha.slice(0, 8)}`;
  const wt = join(repoRoot, worktreeRoot, branch.replace("/", "-"));
  mkdirSync(join(repoRoot, worktreeRoot), { recursive: true });
  git(repoRoot, "fetch", "origin", "main");
  if (!existsSync(wt)) git(repoRoot, "worktree", "add", "-b", branch, wt, "origin/main");
  try {
    git(wt, "revert", "--no-edit", sha);
  } catch {
    git(wt, "revert", "--abort");
    record.revertPrNumber = -1; // attempted; do not retry every sweep
    saveJournal();
    await github.postComment(
      record.issueNumber,
      `Auto-revert of ${sha.slice(0, 7)} conflicted with later landings; a human must revert manually. Main is still red.`,
    );
    return "revert-conflicted";
  }
  await pushBranch(wt, branch);
  const minutes = Math.round((Date.now() - (record.detectedAt ?? Date.now())) / 60_000);
  const prNumber = (
    await github.createPull(
      `[agent] Revert ${sha.slice(0, 7)} — main red for ${minutes} min`,
      branch,
      "main",
      `## Auto-revert (SPEC 6.1)\nMain has been red for ~${minutes} minutes since landing \`${sha}\` ` +
        `failed post-merge CI (issue #${record.issueNumber}). The fix-forwards window expired, so this ` +
        `revert PR was opened automatically. Landing it still needs a human intent approval, like any PR.`,
    )
  ).number;
  record.revertPrNumber = prNumber;
  journal.push({
    delivery: `revert-${sha.slice(0, 8)}`,
    kind: "job",
    issueNumber: record.issueNumber,
    title: `Revert ${sha.slice(0, 7)}`,
    body: "",
    commentBody: "",
    association: "OWNER",
    login: "abc-agent-system",
    posted: false,
    branch,
    prNumber,
    jobStatus: "pr-open",
  });
  saveJournal();
  await github.postComment(
    record.issueNumber,
    `Main still red after the fix window: auto-revert PR #${prNumber} opened (reverts ${sha.slice(0, 7)}). It lands on human intent approval.`,
  );
  return "revert-opened";
}

async function driveCifail(record: DeliveryRecord): Promise<string> {
  const runs = await github.listMainRuns();
  const latest = runs.find((run) => run.status === "completed");
  if (latest !== undefined && latest.conclusion === "success" && latest.headSha !== record.headSha) {
    record.jobStatus = "resolved";
    markPosted(record.delivery);
    await github
      .postComment(record.issueNumber, `Main is green again (run: ${latest.url}). Self-healing loop closed.`)
      .catch(() => undefined);
    return "resolved";
  }
  const windowMs = Number(process.env.ABC_REVERT_AFTER_MINUTES ?? "30") * 60_000;
  if (record.revertPrNumber === undefined && Date.now() - (record.detectedAt ?? 0) > windowMs) {
    return createRevert(record);
  }
  return "still-red";
}

let ciPolling = false;
async function pollMainCi(): Promise<void> {
  if (ciPolling) return;
  ciPolling = true;
  try {
    const runs = await github.listMainRuns();
    const latest = runs.find((run) => run.status === "completed");
    if (latest === undefined || latest.conclusion !== "failure") return;
    const key = latest.headSha.slice(0, 8);
    if (journal.some((record) => record.delivery === `cifail-${key}`)) return;
    const issueNumber = await github.createIssue(
      `[agent] Post-merge CI failed on main (${latest.headSha.slice(0, 7)})`,
      `Post-merge CI (the real gate, SPEC 6.1) failed on \`main\` at \`${latest.headSha}\`.\nRun: ${latest.url}\n` +
        `A fix job has been forked automatically; it will open a fix PR for light intent approval. ` +
        `If main stays red past the revert window, an auto-revert PR follows.`,
    );
    const cifail: DeliveryRecord = {
      delivery: `cifail-${key}`,
      kind: "cifail",
      issueNumber,
      title: "Post-merge CI failure",
      body: "",
      commentBody: "",
      association: "OWNER",
      login: "abc-agent-system",
      posted: false,
      headSha: latest.headSha,
      detectedAt: Date.now(),
    };
    const fix: DeliveryRecord = {
      delivery: `cifix-${key}`,
      kind: "job",
      issueNumber,
      title: `Fix post-merge CI failure on main (${latest.headSha.slice(0, 7)})`,
      body:
        `Post-merge CI is failing on main at commit ${latest.headSha} (run: ${latest.url}). ` +
        `Run \`npm run build\` in your worktree to see the failure, find the cause in the most recent landing, and fix it minimally.`,
      commentBody: "",
      association: "OWNER",
      login: "abc-agent-system",
      posted: false,
    };
    journal.push(cifail, fix);
    saveJournal();
    console.log(`ci: main red at ${key} -> issue #${issueNumber}, fix job forked`);
    driveOnce(fix);
  } catch (error) {
    console.error("ci poll failed", String(error).slice(0, 200));
  } finally {
    ciPolling = false;
  }
}

async function driveDelivery(record: DeliveryRecord): Promise<string> {
  if (record.kind === "job") return driveJob(record);
  if (record.kind === "review") return driveReview(record);
  if (record.kind === "cifail") return driveCifail(record);
  return driveTriage(record);
}

const driving = new Set<string>();
function driveOnce(record: DeliveryRecord): void {
  if (driving.has(record.delivery)) return;
  driving.add(record.delivery);
  void driveDelivery(record)
    .then((result) => console.log(`drive delivery=${record.delivery} -> ${result}`))
    .catch((error: unknown) => console.error(`drive delivery=${record.delivery} failed`, error))
    .finally(() => driving.delete(record.delivery));
}

function sweepUnposted(): void {
  void pollMainCi();
  for (const record of journal.filter((existing) => !existing.posted)) driveOnce(record);
}

// --- Phase A: console (OAuth session, API, WebSocket, static SPA) ---------
// Approval never happens here (SPEC 6.1): the console instructs, steers and
// aborts; landing approval lives on GitHub PRs. Every command re-checks
// collaborator status live against the repo.
const oauthClientId = required("GITHUB_OAUTH_CLIENT_ID");
const oauthClientSecret = required("GITHUB_OAUTH_CLIENT_SECRET");
const publicBase = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

interface Session { login: string; exp: number }
function signSession(login: string): string {
  const payload = Buffer.from(JSON.stringify({ login, exp: Date.now() + 7 * 24 * 3600_000 })).toString("base64url");
  const sig = createHmac("sha256", oauthClientSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function readSession(request: IncomingMessage): Session | undefined {
  const cookie = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("abc_session="));
  if (cookie === undefined) return undefined;
  const [payload, sig] = cookie.slice("abc_session=".length).split(".");
  if (payload === undefined || sig === undefined) return undefined;
  const expected = createHmac("sha256", oauthClientSecret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return session.exp > Date.now() ? session : undefined;
  } catch {
    return undefined;
  }
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
async function requireCollaborator(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
  const session = readSession(request);
  if (session === undefined) {
    json(response, 401, { error: "not signed in" });
    return undefined;
  }
  if (!(await github.isCollaborator(session.login))) {
    json(response, 403, { error: "repo collaborators only" });
    return undefined;
  }
  return session.login;
}

async function conversationById(id: string | undefined): Promise<Conversation | undefined> {
  if (id === undefined) return undefined;
  return harness.conversation(Number(id) as ConversationId, ctx);
}
async function transcriptFor(who: string): Promise<Array<{ role: string; text: string }>> {
  let conversation: Conversation | undefined = who === "triage" ? triage : undefined;
  if (conversation === undefined) {
    const job = journal.find((record) => record.delivery === who);
    conversation = await conversationById(job?.workerConversationId);
  }
  if (conversation === undefined) return [];
  const view = await conversation.context(ctx);
  return view.messages.slice(-120).map((message) => {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const text = blocks
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "toolCall") return `[tool call: ${(block as { name?: string }).name ?? "?"}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return { role: message.role, text: text.slice(0, 2000) || "(tool result)" };
  });
}

const wsClients = new Set<import("node:net").Socket>();
function wsFrame(text: string): Buffer {
  const data = Buffer.from(text);
  const header =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : data.length < 65_536
        ? Buffer.from([0x81, 126, (data.length >> 8) & 0xff, data.length & 0xff])
        : Buffer.from([0x81, 127, 0, 0, 0, 0, (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]);
  return Buffer.concat([header, data]);
}
function wsBroadcast(value: unknown): void {
  const frame = wsFrame(JSON.stringify(value));
  for (const socket of wsClients) {
    try {
      socket.write(frame);
    } catch {
      wsClients.delete(socket);
    }
  }
}
onJournalChange = () => wsBroadcast({ type: "state" });
setInterval(() => {
  if (wsClients.size > 0) wsBroadcast({ type: "tick" });
}, 3000).unref();

const consoleDist = new URL("../console/dist/", import.meta.url);
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
function serveFile(response: ServerResponse, fileUrl: URL): boolean {
  try {
    const content = readFileSync(fileUrl);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(fileUrl.pathname)] ?? "application/octet-stream" });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

async function handleConsole(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/auth/login") {
    const state = randomBytes(16).toString("hex");
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", oauthClientId);
    authorize.searchParams.set("redirect_uri", `${publicBase}/auth/callback`);
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);
    response.writeHead(302, { Location: authorize.toString(), "Set-Cookie": `abc_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` });
    response.end();
    return true;
  }
  if (path === "/auth/logout") {
    response.writeHead(302, { Location: "/", "Set-Cookie": "abc_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
    response.end();
    return true;
  }
  if (path === "/auth/callback") {
    const stateCookie = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("abc_oauth_state="))?.slice("abc_oauth_state=".length);
    const code = url.searchParams.get("code");
    if (code === null || stateCookie === undefined || url.searchParams.get("state") !== stateCookie) {
      json(response, 400, { error: "bad OAuth callback" });
      return true;
    }
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: oauthClientId, client_secret: oauthClientSecret, code, redirect_uri: `${publicBase}/auth/callback` }),
    });
    const tokenData = (await tokenResponse.json()) as { access_token?: string };
    if (tokenData.access_token === undefined) {
      json(response, 401, { error: "OAuth exchange failed" });
      return true;
    }
    const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tokenData.access_token}` } });
    const user = (await userResponse.json()) as { login?: string };
    if (user.login === undefined || !(await github.isCollaborator(user.login))) {
      json(response, 403, { error: "repo collaborators only" });
      return true;
    }
    response.writeHead(302, { Location: "/", "Set-Cookie": `abc_session=${signSession(user.login)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}` });
    response.end();
    return true;
  }
  if (path === "/api/me") {
    const session = readSession(request);
    if (session === undefined) json(response, 401, { error: "not signed in" });
    else json(response, 200, { login: session.login });
    return true;
  }
  if (path === "/api/state") {
    if ((await requireCollaborator(request, response)) === undefined) return true;
    const jobs = journal
      .filter((record) => record.kind === "job" || record.kind === "cifail")
      .map((record) => ({
        delivery: record.delivery,
        kind: record.kind,
        issueNumber: record.issueNumber,
        title: record.title,
        status: record.jobStatus ?? (record.posted ? "done" : "pending"),
        prNumber: record.prNumber,
        approvalBy: record.approvalBy,
      }))
      .reverse();
    json(response, 200, { jobs });
    return true;
  }
  if (path === "/api/transcript") {
    if ((await requireCollaborator(request, response)) === undefined) return true;
    json(response, 200, { messages: await transcriptFor(url.searchParams.get("who") ?? "triage") });
    return true;
  }
  if (request.method === "POST" && (path === "/api/instruct" || path === "/api/steer" || path === "/api/abort")) {
    const login = await requireCollaborator(request, response);
    if (login === undefined) return true;
    const payload = JSON.parse((await readBody(request)).toString("utf8")) as { title?: string; body?: string; delivery?: string; text?: string };
    if (path === "/api/instruct") {
      if (!payload.title || !payload.body) {
        json(response, 400, { error: "title and body required" });
        return true;
      }
      // One issue + one job: the issue is filed by the App, and the job is
      // submitted directly under a ui- requestId - the webhook for the
      // bot-authored issue is ignored (bot sender), so nothing double-fires.
      const issueNumber = await github.createIssue(payload.title, payload.body);
      const record: DeliveryRecord = {
        delivery: `ui-${issueNumber}`,
        kind: "job",
        issueNumber,
        title: payload.title,
        body: payload.body,
        commentBody: "",
        association: "OWNER",
        login,
        posted: false,
      };
      recordDelivery(record);
      driveOnce(record);
      json(response, 200, { issueNumber });
      return true;
    }
    const job = journal.find((record) => record.delivery === payload.delivery && record.kind === "job");
    if (job === undefined) {
      json(response, 404, { error: "job not found" });
      return true;
    }
    const conversation = await conversationById(job.workerConversationId);
    if (path === "/api/steer") {
      if (conversation !== undefined && payload.text) {
        await conversation.submit({ type: "input", content: payload.text, whenBusy: "steer", requestId: `steer-${Date.now()}` }, ctx);
        json(response, 200, { mode: "steered" });
        return true;
      }
      const followUp: DeliveryRecord = {
        delivery: `ui-${job.issueNumber}-${Date.now()}`,
        kind: "job",
        issueNumber: job.issueNumber,
        title: job.title,
        body: `Follow-up instruction from @${login}: ${payload.text ?? ""}`,
        commentBody: "",
        association: "OWNER",
        login,
        posted: false,
      };
      recordDelivery(followUp);
      driveOnce(followUp);
      json(response, 200, { mode: "followup-job" });
      return true;
    }
    // /api/abort
    if (conversation === undefined) {
      json(response, 409, { error: "job is not running" });
      return true;
    }
    await conversation.abort(ctx);
    json(response, 200, { ok: true });
    return true;
  }
  if (request.method === "GET" && !path.startsWith("/api")) {
    if (path === "/" && url.searchParams.get("demo") === "1") {
      serveFile(response, new URL("../index.html", import.meta.url)); // simulation only, SPEC Phase A
      return true;
    }
    if (path === "/") {
      if (serveFile(response, new URL("index.html", consoleDist))) return true;
      json(response, 503, { error: "console not built (npm run console:build)" });
      return true;
    }
    const asset = new URL(`.${path}`, consoleDist);
    if (asset.pathname.startsWith(consoleDist.pathname) && serveFile(response, asset)) return true;
  }
  return false;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (await handleConsole(request, response)) return;
    if (request.method !== "POST" || request.url !== "/webhook") {
      response.writeHead(404); response.end(); return;
    }
    const raw = await readBody(request);
    if (!github.verifySignature(raw, request.headers["x-hub-signature-256"] as string | undefined)) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "bad signature" }));
      return;
    }
    const event = String(request.headers["x-github-event"] ?? "");
    const delivery = String(request.headers["x-github-delivery"] ?? "");
    const payload = JSON.parse(raw.toString("utf8")) as IssuePayload;
    const record = delivery ? toRecord(event, delivery, payload) : undefined;
    if (record === undefined) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: "ignored" }));
      return;
    }
    // ACK within GitHub's 10s window: journal first, drive in background.
    const isNew = recordDelivery(record);
    console.log(`webhook ${event} delivery=${delivery} -> queued${isNew ? "" : " (known)"}`);
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: "queued" }));
    if (isNew) driveOnce(record);
  } catch (error) {
    console.error("webhook error", error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String(error) }));
  }
});

// WebSocket live channel: snapshot events on journal change + 3s ticks.
// Commands travel over POST /api/*; the socket is server -> client only.
server.on("upgrade", (request: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const key = request.headers["sec-websocket-key"];
  if (url.pathname !== "/ws" || typeof key !== "string" || readSession(request) === undefined) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if (head.length > 0) socket.unshift(head);
  wsClients.add(socket);
  socket.write(wsFrame(JSON.stringify({ type: "state" })));
  socket.on("data", (chunk: Buffer) => {
    let offset = 0;
    while (offset + 2 <= chunk.length) {
      const opcode = chunk[offset] & 0x0f;
      const masked = (chunk[offset + 1] & 0x80) !== 0;
      let len = chunk[offset + 1] & 0x7f;
      let headerLen = 2;
      if (len === 126) {
        if (offset + 4 > chunk.length) return;
        len = chunk.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (len === 127) return;
      if (masked) headerLen += 4;
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) socket.write(Buffer.from([0x8a, 0])); // pong
      offset += headerLen + len;
    }
  });
  socket.on("close", () => wsClients.delete(socket));
  socket.on("error", () => wsClients.delete(socket));
});

const port = Number(process.env.PORT ?? 8971);
server.listen(port, "127.0.0.1", () => console.log(`service listening on http://127.0.0.1:${port}`));
sweepUnposted(); // recover anything a previous crash left unposted
setInterval(sweepUnposted, 60_000).unref();

async function shutdown(): Promise<void> {
  server.close();
  await harness.close(ctx);
  rmSync(`${storagePath}.lock`, { force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
