// Harness service (Mac proof host): webhook ingress -> triage (Phase B) and
// Phase C jobs: worker in a worktree -> draft branch -> reviewer critique +
// deterministic classifier -> PR with intent packet -> squash-merge only on
// a human's GitHub approval. The service, never a model, does git/GitHub.
//   npm run build && node dist/service.js     (listens on PORT, default 8971)
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, Harness, type Conversation, type EntryId } from "@earendil-works/pi-durable";
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
  kind?: "triage" | "job" | "review"; // absent in old journal entries = triage
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
  branch?: string;
  prNumber?: number;
  jobStatus?: string; // working | pr-open | merged | no-changes | failed
  approvalBy?: string; // first write wins (SPEC 6.1)
}
const journalPath = `${storagePath}.deliveries.json`;
const journal: DeliveryRecord[] = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as DeliveryRecord[])
  : [];
function saveJournal(): void {
  writeFileSync(journalPath, JSON.stringify(journal));
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
}): Promise<string | undefined> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "openrouter", modelId: options.model }, cwd: options.cwd },
      },
      ctx,
    );
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
  const reviews = await github.listReviews(job.prNumber);
  let approver = reviews.find(
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
    });
    if (workerText === undefined) {
      record.jobStatus = "failed";
      markPosted(record.delivery);
      await github.postComment(record.issueNumber, `${marker}\nAgent job failed after retries (worker model unavailable).`);
      return "worker-failed";
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
          "missing tests (flag missing tests, or missing simulation/fuzz for infra-like changes), and risks. Short bullets.",
        content:
          `Review this change for GitHub issue #${record.issueNumber}.\nFiles changed:\n` +
          `${files.map((file) => `- ${file.path}`).join("\n")}\nClassifier: level=${result.level} labels=${result.labels.join(",") || "none"}\n` +
          `Diff (truncated):\n\`\`\`diff\n${diff.slice(0, 12_000)}\n\`\`\``,
        requestId: `${record.delivery}:reviewer`,
      })) ?? "(reviewer produced no critique)";
    // Service-side push with the App token; the token never reaches a model.
    const token = await github.installationToken();
    try {
      execFileSync("git", ["push", `https://x-access-token:${token}@github.com/${repoSlug}.git`, branch], {
        cwd: wt,
        stdio: "pipe",
        timeout: 180_000,
      });
    } catch {
      throw new Error("git push of draft branch failed"); // sanitized: never log the token URL
    }
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

async function driveDelivery(record: DeliveryRecord): Promise<string> {
  if (record.kind === "job") return driveJob(record);
  if (record.kind === "review") return driveReview(record);
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
  for (const record of journal.filter((existing) => !existing.posted)) driveOnce(record);
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
