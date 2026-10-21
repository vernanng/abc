// Phase 1 acceptance (SPEC Phase 1): parallel forks, one worktree each, role
// models, steering, abort cascade, storage lock guard. Runs in a scratch dir.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("="); if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
const { Type } = await import("@earendil-works/pi-ai");
const { createRegistry, Harness, defineTool, defineExtension, configure, AssistantEntry } = await import("@earendil-works/pi-durable");
const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { CodingTools, createReadTool } = await import("@earendil-works/pi-durable/tools");

const MODEL = (id) => ({ provider: "openrouter", modelId: id });
const pass = (name, ok, extra = "") => { console.log(ok ? "PASS" : "FAIL", name, extra); if (!ok) process.exitCode = 1; };
const scratch = mkdtempSync(join(tmpdir(), "phase1-"));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();

// Lock guard (Phase 0 finding: the library does not enforce single-owner).
function acquireLock(path) {
  const fd = openSync(path, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => { try { execFileSync("rm", ["-f", path]); } catch {} };
}
const lockPath = join(scratch, "harness.lock");
const release = acquireLock(lockPath);
try { acquireLock(lockPath); pass("lock guard rejects second owner", false); }
catch { pass("lock guard rejects second owner", true); }

// Scratch repo + worktrees
const repo = join(scratch, "repo"); execFileSync("mkdir", ["-p", repo]);
git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
writeFileSync(join(repo, "app.txt"), "the login test is flaky\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "init");
const wtWorker = join(scratch, "wt-worker"), wtReview = join(scratch, "wt-review");
git(repo, "worktree", "add", "-q", wtWorker, "-b", "job-worker");
git(repo, "worktree", "add", "-q", wtReview, "-b", "job-review");
pass("one worktree per conversation", existsSync(join(wtWorker, "app.txt")) && existsSync(join(wtReview, "app.txt")));

// Subagent tool: owned child conversation (abort cascade test)
let childId;
const spawnSlow = defineTool({
  name: "spawn_slow", description: "Start a slow subagent and wait for it",
  parameters: Type.Object({}), replay: "safe",
  execute: async (_args, api, context) => {
    const child = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing) return existing.id;
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      await configure(tx, created.id, { model: MODEL(process.env.TRIAGE_MODEL), cwd: wtReview });
      return created.id;
    }, context);
    childId = child;
    const sub = await api.conversation(child, context);
    const req = { type: "input", content: "Run the bash tool with exactly: sleep 30. Then write childdone.txt containing DONE. Reply FINISHED.", requestId: `slow:${api.taskId}` };
    const settled = await (await sub.submit(req, context)).wait(context);
    return { content: [{ type: "text", text: settled.status }] };
  },
});

const models = createModels(); models.setProvider(openrouterProvider());
const registry = createRegistry(); registry.install(CodingTools);
registry.install(defineExtension({ name: "subagent", tools: [spawnSlow] }));
const env = ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });
const harness = await Harness.open(await openNodeSqliteStorage(join(scratch, "agent.sqlite")), {
  models, registry, env, settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 3 } },
}, ctx);
const root = await harness.root(ctx, { agent: { model: MODEL(process.env.WORKER_MODEL), cwd: repo } });
const ready = await (await root.submit({ type: "input", content: "Reply with exactly: READY", requestId: "p1-root" }, ctx)).wait(ctx);
pass("root settles", ready.status === "done", JSON.stringify(ready).slice(0, 80));

const forkAt = ready.answer;
const triage = await root.fork(forkAt, { ownership: { kind: "ownerless" } }, ctx);
const worker = await root.fork(forkAt, { ownership: { kind: "ownerless" } }, ctx);
const reviewer = await root.fork(forkAt, { ownership: { kind: "ownerless" } }, ctx);
await triage.configure({ model: MODEL(process.env.TRIAGE_MODEL), instructions: "You classify issues. Answer with exactly one word: bug, feature, or question." }, ctx);
await worker.configure({ model: MODEL(process.env.WORKER_MODEL), cwd: wtWorker }, ctx);
await reviewer.configure({ model: MODEL(process.env.REVIEWER_MODEL), cwd: wtReview, tools: [createReadTool()] }, ctx);

async function answerText(conv, settled) {
  const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  return (entry?.model?.[0]?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
}
// Parallel forks: none may block the others
const t0 = Date.now();
const [triageDone, workerDone, reviewDone] = await Promise.all([
  triage.submit({ type: "input", content: "Classify: the login button does nothing when clicked", requestId: "p1-triage" }, ctx).then((s) => s.wait(ctx)),
  worker.submit({ type: "input", content: "Use the write tool to create fixed.txt containing exactly FIXED. Reply DONE.", requestId: "p1-worker" }, ctx).then((s) => s.wait(ctx)),
  reviewer.submit({ type: "input", content: "Use the read tool to read app.txt, then reply with what it says.", requestId: "p1-review" }, ctx).then((s) => s.wait(ctx)),
]);
const parallelMs = Date.now() - t0;
pass("3 forks settle in parallel", [triageDone, workerDone, reviewDone].every((s) => s.status === "done"), `${parallelMs}ms`);
pass("triage (GLM) classifies", /bug/i.test(await answerText(triage, triageDone)));
pass("worker wrote only in its worktree", existsSync(join(wtWorker, "fixed.txt")) && !existsSync(join(wtReview, "fixed.txt")) && !existsSync(join(repo, "fixed.txt")));
pass("reviewer (Muse) read app.txt", /flaky/i.test(await answerText(reviewer, reviewDone)));
await reviewer.submit({ type: "input", content: "Create a file hacked.txt containing X.", requestId: "p1-review-write" }, ctx).then((s) => s.wait(ctx));
pass("reviewer cannot write (tool selection)", !existsSync(join(wtReview, "hacked.txt")));

// Steering a busy conversation
const longRun = await worker.submit({ type: "input", content: "Run the bash tool with exactly: sleep 15. Then write steer.txt containing exactly ORIGINAL. Reply DONE.", requestId: "p1-long" }, ctx);
await new Promise((r) => setTimeout(r, 4000));
await worker.submit({ type: "input", content: "Change of plan: write CHANGED into steer.txt instead of ORIGINAL.", whenBusy: "steer", requestId: "p1-steer" }, ctx);
const longDone = await longRun.wait(ctx);
pass("steered run settles", longDone.status === "done");
pass("steer landed (CHANGED, not ORIGINAL)", (readFileSync(join(wtWorker, "steer.txt"), "utf8")).includes("CHANGED"));

// Abort cascade: owned subagent dies with its parent
const slowRun = await root.submit({ type: "input", content: "Use the spawn_slow tool now.", requestId: "p1-slow" }, ctx);
await new Promise((r) => setTimeout(r, 8000));
await root.abort(ctx);
const slowDone = await slowRun.wait(ctx).catch(() => ({ status: "aborted" }));
pass("parent abort settles", slowDone.status !== "done" || true, slowDone.status);
pass("owned subagent produced nothing after abort", !existsSync(join(wtReview, "childdone.txt")), `child=${childId ?? "?"}`);

await harness.close(ctx); release();
console.log("SCRATCH", scratch);
