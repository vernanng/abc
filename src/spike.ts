// Phase 0 durability spike (SPEC Phase 0). Usage:
//   npm run spike -- submit   # submit job-42, wait for it
//   npm run spike -- resume   # reopen storage, resume, resubmit job-42 (must dedupe)
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const mode: string = process.argv[2] ?? "submit";
const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(openrouterProvider());
const registry = createRegistry();
registry.install(CodingTools);
const env = ({ cwd }: { cwd?: string }): NodeExecutionEnv =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });
const harness: Harness = await Harness.open(await openNodeSqliteStorage("./agent.sqlite"), {
  models,
  registry,
  env,
  settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 3 } },
}, context);
if (mode === "resume") harness.resume();
const root = await harness.root(context, {
  agent: {
    model: { provider: "openrouter", modelId: process.env.WORKER_MODEL ?? "" },
    cwd: process.cwd(),
  },
});
if (mode === "open-only") {
  console.log("OPEN_OK");
  await harness.close(context);
  process.exit(0);
}
if (mode === "inspect") {
  const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 200), context);
  for (const entry of page.items) {
    console.log("ENTRY", entry.kind, JSON.stringify(entry.model ?? "").slice(0, 220));
  }
  const view = await root.viewState(context);
  console.log("USAGE", JSON.stringify(view.value.docs["pi.usage"] ?? null).slice(0, 300));
  await harness.close(context);
  process.exit(0);
}

const job = {
  type: "input",
  requestId: "job-42",
  content:
    "Do these steps in order. Step 1: run the bash tool with exactly this command: sleep 20. Step 2: run the bash tool with exactly this command: echo ran >> counter.txt. Step 3: use the write tool to create proof.txt containing exactly DONE. Then reply with the single word FINISHED.",
} as const;
const submission = await root.submit(job, context);
console.log("SUBMISSION_ID", submission.id, "mode", mode);
const settled = await submission.wait(context);
console.log("SETTLED", settled.status, settled.type ?? "");
const view = await root.viewState(context);
console.log("USAGE", JSON.stringify(view.value.docs["pi.usage"] ?? null).slice(0, 300));
await harness.close(context);
