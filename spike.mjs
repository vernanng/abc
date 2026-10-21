// Phase 0 durability spike (SPEC Phase 0). Usage:
//   node spike.mjs submit   # submit job-42, wait for it
//   node spike.mjs resume   # reopen storage, resume, resubmit job-42 (must dedupe)
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("="); if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i)] = line.slice(i + 1);
}
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { CodingTools } = await import("@earendil-works/pi-durable/tools");

const mode = process.argv[2] ?? "submit";
const context = BACKGROUND_CONTEXT;
const models = createModels(); models.setProvider(openrouterProvider());
const registry = createRegistry(); registry.install(CodingTools);
const env = ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });
const harness = await Harness.open(await openNodeSqliteStorage("./agent.sqlite"), { models, registry, env }, context);
if (mode === "resume") harness.resume();
const root = await harness.root(context, {
  agent: { model: { provider: "openrouter", modelId: process.env.WORKER_MODEL }, cwd: process.cwd() },
});
const job = {
  type: "input", requestId: "job-42",
  content: "First run the bash tool with exactly this command: sleep 20. Then use the write tool to create a file named proof.txt containing exactly the text DONE. Then reply with the single word FINISHED.",
};
const submission = await root.submit(job, context);
console.log("SUBMISSION_ID", submission.id, "mode", mode);
const settled = await submission.wait(context);
console.log("SETTLED", settled.status, settled.type ?? "");
await harness.close(context);
