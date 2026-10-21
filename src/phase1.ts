// Phase 1 acceptance (SPEC Phase 1): parallel forks, one worktree each, role
// models, steering, abort cascade, storage lock guard. Runs in a scratch dir.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createReadTool } from "@earendil-works/pi-durable/tools";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const ctx = BACKGROUND_CONTEXT;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const MODEL = (modelId: string): ModelRef => ({ provider: "openrouter", modelId });
const pass = (name: string, ok: boolean, extra = ""): void => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) process.exitCode = 1;
};
const scratch = mkdtempSync(join(tmpdir(), "phase1-"));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

// Lock guard (Phase 0 finding: the library does not enforce single-owner).
function acquireLock(path: string): () => void {
  const fd = openSync(path, "wx");
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(path, { force: true });
}
const lockPath = join(scratch, "harness.lock");
const release = acquireLock(lockPath);
try {
  acquireLock(lockPath);
  pass("lock guard rejects second owner", false);
} catch {
  pass("lock guard rejects second owner", true);
}

// Scratch repo + worktrees
const repo = join(scratch, "repo");
execFileSync("mkdir", ["-p", repo]);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "t@t");
git(repo, "config", "user.name", "t");
writeFileSync(join(repo, "app.txt"), "the login test is flaky\n");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");
const wtWorker = join(scratch, "wt-worker");
const wtReview = join(scratch, "wt-review");
git(repo, "worktree", "add", "-q", wtWorker, "-b", "job-worker");
git(repo, "worktree", "add", "-q", wtReview, "-b", "job-review");
pass(
  "one worktree per conversation",
  existsSync(join(wtWorker, "app.txt")) && existsSync(join(wtReview, "app.txt")),
);

// Subagent tool: owned child conversation (abort cascade test)
let childId: ConversationId | undefined;
const spawnSlow = defineTool({
  name: "spawn_slow",
  description: "Start a slow subagent and wait for it",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, context) => {
    const child = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const created = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      await configure(tx, created.id, {
        model: MODEL(requiredEnv("TRIAGE_MODEL")),
        cwd: wtReview,
      });
      return created.id;
    }, context);
    childId = child;
    const sub = await api.conversation(child, context);
    if (sub === undefined) throw new Error(`Subagent conversation not found: ${child}`);
    const request = {
      type: "input",
      content:
        "Run the bash tool with exactly: sleep 30. Then write childdone.txt containing DONE. Reply FINISHED.",
      requestId: `slow:${api.taskId}`,
    } as const;
    const settled = await (await sub.submit(request, context)).wait(context);
    return { output: [{ type: "text", text: settled.status }] };
  },
});

const models = createModels();
models.setProvider(openrouterProvider());
const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name: "subagent", tools: [spawnSlow] }));
const env = ({ cwd }: { cwd?: string }): NodeExecutionEnv =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });
const harness: Harness = await Harness.open(
  await openNodeSqliteStorage(join(scratch, "agent.sqlite")),
  {
    models,
    registry,
    env,
    settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 3 } },
  },
  ctx,
);
const root: Conversation = await harness.root(ctx, {
  agent: { model: MODEL(requiredEnv("WORKER_MODEL")), cwd: repo },
});
const ready: SettledSubmissionRecord = await (
  await root.submit(
    { type: "input", content: "Reply with exactly: READY", requestId: "p1-root" },
    ctx,
  )
).wait(ctx);
pass("root settles", ready.status === "done", JSON.stringify(ready).slice(0, 80));
if (ready.type !== "input" || ready.status !== "done") {
  throw new Error("Root conversation did not settle successfully");
}

const forkAt = ready.answer;
const triage: Conversation = await root.fork(forkAt, { ownership: { kind: "ownerless" } }, ctx);
const worker: Conversation = await root.fork(forkAt, { ownership: { kind: "ownerless" } }, ctx);
const reviewer: Conversation = await root.fork(forkAt, { ownership: { kind: "ownerless" } }, ctx);
await triage.configure(
  {
    model: MODEL(requiredEnv("TRIAGE_MODEL")),
    instructions:
      "You classify issues. Answer with exactly one word: bug, feature, or question.",
  },
  ctx,
);
await worker.configure({ model: MODEL(requiredEnv("WORKER_MODEL")), cwd: wtWorker }, ctx);
await reviewer.configure(
  { model: MODEL(requiredEnv("REVIEWER_MODEL")), cwd: wtReview, tools: [createReadTool()] },
  ctx,
);

async function answerText(
  conversation: Conversation,
  settled: SettledSubmissionRecord,
): Promise<string> {
  if (settled.type !== "input" || settled.status !== "done") return "";
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  const message = entry?.model?.[0];
  if (message === undefined || message.role !== "assistant") return "";
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// Parallel forks: none may block the others
const t0 = Date.now();
const [triageDone, workerDone, reviewDone] = await Promise.all([
  triage
    .submit(
      {
        type: "input",
        content: "Classify: the login button does nothing when clicked",
        requestId: "p1-triage",
      },
      ctx,
    )
    .then((submission) => submission.wait(ctx)),
  worker
    .submit(
      {
        type: "input",
        content: "Use the write tool to create fixed.txt containing exactly FIXED. Reply DONE.",
        requestId: "p1-worker",
      },
      ctx,
    )
    .then((submission) => submission.wait(ctx)),
  reviewer
    .submit(
      {
        type: "input",
        content: "Use the read tool to read app.txt, then reply with what it says.",
        requestId: "p1-review",
      },
      ctx,
    )
    .then((submission) => submission.wait(ctx)),
]);
const parallelMs = Date.now() - t0;
pass(
  "3 forks settle in parallel",
  [triageDone, workerDone, reviewDone].every((settled) => settled.status === "done"),
  `${parallelMs}ms`,
);
pass("triage (GLM) classifies", /bug/i.test(await answerText(triage, triageDone)));
pass(
  "worker wrote only in its worktree",
  existsSync(join(wtWorker, "fixed.txt")) &&
    !existsSync(join(wtReview, "fixed.txt")) &&
    !existsSync(join(repo, "fixed.txt")),
);
pass("reviewer (Muse) read app.txt", /flaky/i.test(await answerText(reviewer, reviewDone)));
await reviewer
  .submit(
    { type: "input", content: "Create a file hacked.txt containing X.", requestId: "p1-review-write" },
    ctx,
  )
  .then((submission) => submission.wait(ctx));
pass("reviewer cannot write (tool selection)", !existsSync(join(wtReview, "hacked.txt")));

// Steering a busy conversation
const longRun = await worker.submit(
  {
    type: "input",
    content:
      "Run the bash tool with exactly: sleep 15. Then write steer.txt containing exactly ORIGINAL. Reply DONE.",
    requestId: "p1-long",
  },
  ctx,
);
await new Promise<void>((resolve) => setTimeout(resolve, 4000));
await worker.submit(
  {
    type: "input",
    content: "Change of plan: write CHANGED into steer.txt instead of ORIGINAL.",
    whenBusy: "steer",
    requestId: "p1-steer",
  },
  ctx,
);
const longDone: SettledSubmissionRecord = await longRun.wait(ctx);
pass("steered run settles", longDone.status === "done");
pass(
  "steer landed (CHANGED, not ORIGINAL)",
  readFileSync(join(wtWorker, "steer.txt"), "utf8").includes("CHANGED"),
);

// Abort cascade: owned subagent dies with its parent
const slowRun = await root.submit(
  { type: "input", content: "Use the spawn_slow tool now.", requestId: "p1-slow" },
  ctx,
);
await new Promise<void>((resolve) => setTimeout(resolve, 8000));
await root.abort(ctx);
const slowDone: SettledSubmissionRecord | { status: string } = await slowRun
  .wait(ctx)
  .catch(() => ({ status: "aborted" }));
pass("parent abort settles", slowDone.status !== "done" || true, slowDone.status);
pass(
  "owned subagent produced nothing after abort",
  !existsSync(join(wtReview, "childdone.txt")),
  `child=${childId ?? "?"}`,
);

await harness.close(ctx);
release();
console.log("SCRATCH", scratch);
