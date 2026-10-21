// Phase B service (Mac proof host): webhook ingress -> triage conversation ->
// triage comment on the issue. Read-only: no write tools reach GitHub or disk.
//   npm run build && node dist/service.js     (listens on PORT, default 8971)
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, Harness, type Conversation, type EntryId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
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

async function triageAnswer(answerId: EntryId): Promise<string> {
  const entry = await triage.commit((tx) => tx.entry(AssistantEntry, answerId), ctx);
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
  issue?: { number: number; title?: string; body?: string | null; author_association?: string };
  comment?: { body?: string; author_association?: string };
  sender?: { login?: string };
}

const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

async function handleWebhook(event: string, delivery: string, payload: IssuePayload): Promise<string> {
  const isIssueOpen = event === "issues" && payload.action === "opened";
  const isAgentComment =
    event === "issue_comment" && payload.action === "created" && (payload.comment?.body ?? "").includes("@agent");
  if (!isIssueOpen && !isAgentComment) return "ignored";
  const issue = payload.issue;
  if (issue === undefined) return "ignored";
  const association = (isAgentComment ? payload.comment?.author_association : issue.author_association) ?? "";
  const login = payload.sender?.login ?? "";
  if (!ASSOCIATIONS.has(association) && !(login && (await github.isCollaborator(login)))) {
    const marker = `<!-- abc-agent:${delivery} -->`;
    if (!(await github.findCommentWithMarker(issue.number, marker))) {
      await github.postComment(issue.number, `${marker}\nOnly repo collaborators can instruct the agent.`);
    }
    return "refused-non-collaborator";
  }
  const marker = `<!-- abc-agent:${delivery} -->`;
  if (await github.findCommentWithMarker(issue.number, marker)) return "already-commented";
  const content =
    `GitHub issue #${issue.number}: ${issue.title ?? ""}\n\n${issue.body ?? ""}` +
    (isAgentComment ? `\n\nTriggering comment: ${payload.comment?.body ?? ""}` : "");
  const submission = await triage.submit(
    { type: "input", content, requestId: delivery },
    ctx,
  );
  const settled = await submission.wait(ctx);
  if (settled.type !== "input" || settled.status !== "done") return `unanswered:${settled.status}`;
  const answer = await triageAnswer(settled.answer);
  if (await github.findCommentWithMarker(issue.number, marker)) return "already-commented";
  await github.postComment(issue.number, `${marker}\n${answer || "Triage: question — no classification produced."}`);
  return "triaged";
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
    const result = await handleWebhook(event, delivery, payload);
    console.log(`webhook ${event} delivery=${delivery} -> ${result}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.error("webhook error", error);
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String(error) }));
  }
});

const port = Number(process.env.PORT ?? 8971);
server.listen(port, "127.0.0.1", () => console.log(`service listening on http://127.0.0.1:${port}`));

async function shutdown(): Promise<void> {
  server.close();
  await harness.close(ctx);
  rmSync(`${storagePath}.lock`, { force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
