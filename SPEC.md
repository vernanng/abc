# SPEC: Scion-style vibe coding on Pi Durable + GitHub

Status: draft, pre-implementation. Source plan: `PLAN.md`. Demo: `index.html` (simulation only).
Rule: no code beyond the demo until this spec is accepted. Changing a requirement = edit this file first.

## 1. Goal / Non-goals

**Goal:** A hosted web app where multiple users assign coding work to durable agents that operate on one GitHub repo, following Anthropic's agentic workflow as closely as git/GitHub allow: agents survive crashes/restarts and work in parallel; a human reviews the **intent** of every change (not every line); there is no merge queue and no pre-merge CI gate — changes land on intent approval and are verified by post-merge + pre-deploy testing, with agents fixing breakage forwards or reverting.

**Non-goals (explicit, until measured need):** new VCS/changeset store, merge queue, multi-repo support, multi-machine/sharded harness, Kubernetes, per-directory IAM engine, virtual filesystem, billing.

## 2. Principles (from PLAN.md §2, binding)

1. Git stays; only the workflow is borrowed from Scion.
2. Work unit = durable conversation fork, not a long-lived branch. Sole exception: the PR branch.
3. Humans give instructions and review the **intent of every change** before it lands (§6.1) — intent, plan, risk, and evidence, not line-by-line diff reading. The model reviewer is adversarial pre-review; it never approves landing. High-risk changes additionally require the owning human(s) via CODEOWNERS.
4. Effects are exactly-once or explicitly interrupted — never silently duplicated.
5. `replay:"safe"` is for reads only.

## 3. Architecture

```
                    ┌──────────────────── VPS (architecture B, decided 2026-10-21) ───────────────────┐
GitHub repo ──webhook──▶ Caddy (TLS) ──▶ Harness service (systemd, one process)
                                            │  Pi Durable: Harness.open(SQLite on local disk)
                                            │  ├─ root conversation (triage/dispatch)
                                            │  ├─ task conversations (1 per job, own git worktree)
                                            │  ├─ reviewer conversation (read-only)
                                            │  └─ superfan conversations (background, ownerless)
                                            ├─ Worker/reviewer/triage = Pi Durable conversations calling OpenRouter models
                                            │    all roles: models via OpenRouter API (pi-ai provider `openrouter`)
                                            └─ WebSocket: watch() ops / viewState()
Web clients ──HTTPS/WSS──▶ Caddy ──▶ console (static) + harness service
GitHub App ◀── REST (installation token) ── harness service (PR create/merge/comment)
                    └──────────────────────────────────────────────────────────────────────────────────────┘
Deferred v2: Cloudflare Durable Object per repo + Cloudflare Containers (grill-2 design) — only if the proof outgrows one VPS. The ExecEnv seam (§5) is where execution moves; harness state moves DO-side at that point.
```

- **Site:** Vite + React/Preact console (grill 2), served by Caddy on the VPS for the proof (Pages is a later static split, no code change). The vanilla `index.html` simulation survives only behind `?demo=1`. The site is an **ops console + instruction entry point**: filing a feature in the UI creates the GitHub issue (single source of truth) and submits its ID as the job `requestId` — the webhook for that same issue dedupes against it, so UI-first and GitHub-first instructions converge on one job.
- **Harness host: one VPS (architecture B); proof host = this Mac first (decided 2026-10-21).** Target repo: `vernanng/abc` (this repo). Single harness process owns the SQLite storage on local disk — that process *is* the single owner Pi Durable requires. Restart (crash, deploy, reboot) = process restarts, `harness.resume()` continues from checkpoints. No second instance may ever open the same storage. Mac proof uses a launchd/manual process in place of systemd; nothing else changes.
- **Wake contract:** no DO alarms in B. Sleeping tasks use Pi Durable's stored sleeps + process timers (`setTimer`/`now` defaults); a stopped service simply fires overdue sleeps on `resume()`. (The binding DO alarm contract returns in v2.)
- **Execution is local:** one git worktree per conversation on the host, Pi Durable tools (`bash`/`read`/`write`/`edit`) run inside it; models are remote via the Console API. VPS compromise or disk loss must never lose code state: worktrees are rebuildable from git + the durable transcript; unlanded work is pushed to the job's **draft branch** (`agent/<jobId>`, exempt from the approval gate — §6.1) before any long pause. The gate applies to PR-open and merge, never to draft pushes.

## 4. Components

| # | Component | Responsibility | Pi Durable primitive |
|---|---|---|---|
| C1 | Ingress | Verify GitHub webhook signature; map delivery → submission | `submit({requestId: deliveryId})` |
| C2 | Dispatcher (root) | Triage input, fork task conversations, report status to issue/PR | `fork(entryId)`, subagent tool pattern (ex. 22/23) |
| C3 | Worker conversation | Implement one job in its own local worktree; run tests | per-conversation `cwd` + `NodeExecutionEnv`, `CodingTools`; model via OpenRouter API |
| C4 | Reviewer conversation (adversarial) | Read-only critique of plan + diff: constraint violations, over-engineering, missing tests. Posts critique doc + PR comment; never approves | `configure({tools:{remove:[write,edit,bash]}})`, free model via OpenCode (different family than worker) |
| C5 | Intent-review gate + risk classifier | Classify every change on the final tree diff (§6.1); route: comment/docs-only → light review; sensitive → CODEOWNERS. Block merge until a human records **intent approval** on the PR. Decisions survive restart | deterministic classifier + `hook(ToolTask,{beforeTool})` + `api.memo("approval-human:<jobId>")`; GitHub PR review = approval record |
| C6 | Landing task | On intent approval: squash-merge immediately (no CI gate, no merge queue), delete branch/worktree; then post-merge verify on `main`; on failure fork fix conversation, and revert the landing if main stays red | `defineTask` phases `land → verify → fix-or-revert`, `background:true` verify |
| C7 | Superfan (×N) | One watcher per surface (main CI, landing pipeline, test logs): tails output, forks fix work, steers main only on anomaly | background ownerless conversation, `replay:"safe"` log tool |
| C8 | Web client (console) | File instructions (creates GitHub issue), live transcript/tool output, steer, high-risk approve, abort; late join from current view | Vite + React/Preact on Pages; `viewState()` / `watch()` over WSS; GitHub OAuth session |
| C9 | Budget guard | Per-conversation spend cap; stop runaway runs | `pi.usage` doc + `onYield` hook |

State that must be durable (all in harness SQLite storage on the VPS, none in process memory): transcripts, submissions/`requestId`s, plan & review docs (`defineDoc`, `fork:"asOf"`), approval memos, task checkpoints, usage. Files/code live only in per-conversation worktrees + git; a worktree is a cache, never the source of truth. **Retention:** landed/aborted jobs are archived to object storage (R2 or local tarball dir for proof) after a configured TTL (default 30 days) — storage keeps live jobs plus an index (job ID, outcome, archive key); archived transcripts are read-only, never reloaded.

## 5. Interfaces

**Inbound (GitHub App webhooks, signature-verified):** `issues.opened/edited`, `issue_comment.created` (`@agent …`), `pull_request_review_comment`, `check_run.completed` / Actions failure, `pull_request.closed`. Each handler: dedupe by delivery ID, then `submit()`; unrecognized events are acked `200` and dropped. **Instruction authorization:** only repo collaborators may instruct (decided 2026-10-21). A non-collaborator issue/comment gets one refusal comment and runs no agent, forks no conversation, and spends no budget.

**Outbound (GitHub REST, installation token, least scope):** read issue/PR, create/update PR, comment, request review, merge (squash only). Token is injected into the execution env / API client; never present in tool arguments or transcript text.

**Tools (per conversation, selected by role):**
- Worker: `read, write, edit, bash, search_history` + `gh_read` (`replay:"safe"`), `push_draft` (non-safe, ungated — draft branch only), `open_pr`, `merge` (both non-safe, gated by C5).
- Reviewer: `read, gh_read` only.
- Superfan: `tail_logs` (`replay:"safe"`) + `submit(steer)` to main.

**Execution env (per conversation, local in B):** Pi Durable `NodeExecutionEnv` over one git worktree per conversation; agent CLIs (OpenCode/Pi) run as subprocesses with that worktree as cwd. Clone strategy: **partial + sparse** — `git clone --filter=blob:none --sparse` at the job base commit. Worktree lifecycle: kept while the job is live (draft-pushed before long pauses), deleted on land/abort; resume recreates from `agent/<jobId>`. (v2 replaces this with the remote contract: Cloudflare Containers behind the same seam.)
**Model routing (B, final 2026-10-21):** all roles call models through the **OpenRouter API** (pi-ai provider `openrouter`, `OPENROUTER_API_KEY`) — no local OpenCode instance, no CLI subprocess agent, no Console key (proven unusable from Pi: free tier is app-locked, no paid/Go access — see git history). Pi Durable conversations make the model calls; tools run via the local execution env. Defaults mirroring the operator's picks: worker = `deepseek/deepseek-v4.1-flash`; reviewer = `z-ai/glm-5.3-flash` (**different family** — the §6.1 independence mechanism); triage = `minimax/minimax-m3`. Per-role model IDs live in config (§5 Config), never in code. OpenRouter is pay-as-you-go and dollar-metered per call, so the C9 budget guard has a real meter again (§10).

**Web client protocol:** WSS to Caddy → harness service → snapshot (`viewState`) then commit ops (`watch`). Client commands: `instruct` (creates GitHub issue + job), `submit` (follow-up/steer), `abort(conversationId)`. There is **no web approve command** — intent approval is a GitHub PR review (§6.1); the console shows the review/landing queue and deep-links each PR. Auth: **GitHub OAuth**; collaborator status checked live against the repo on each command, never cached into a local role table.

**Config (env file on the VPS, no code changes):** `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, `REPO` (`vernanng/abc`), model IDs per role (`WORKER_MODEL`, `REVIEWER_MODEL`, `TRIAGE_MODEL`), `OPENROUTER_API_KEY`, per-conversation budget, storage/worktree paths. No CLI auth files are used.

## 6. Key flows

1. **New job:** collaborator files instruction → C1 dedupes + authorizes → root submits → triage (cheap) → fork worker + reviewer in parallel, each own worktree → worker writes plan doc → worker implements (with tests; simulation/fuzz cases for infra-like changes, §6.1) → draft pushes to `agent/<jobId>` (ungated) → PR opened with an **intent packet**: instruction, plan, classifier output, reviewer critique, test evidence.
2. **Landing (Anthropic-aligned):** a human reviews the intent packet on the PR and approves intent (sensitive paths also require CODEOWNERS approval) → C6 squash-merges **immediately — PR CI is advisory only, branch protection has no required status checks, GitHub merge queue is disabled** → background post-merge verify on `main` (+ pre-deploy test where a deploy exists) → fail ⇒ fix conversation forked with the failure, fixing forwards; if `main` stays red past the configured window, C6 reverts the landing commit and posts why. Landing conflicts are fixed by the worker conversation, never by a queue.

### 6.1 Review & landing policy (binding, Anthropic-aligned 2026-10-21 — supersedes model-approval decisions above)
- **Every change gets a human intent review before landing.** The human reviews the intent packet (instruction, plan, classifier output, reviewer critique, test evidence) on the GitHub PR — intent, not every line. A GitHub PR approval by a collaborator is the approval record; the harness mirrors it into `approval-human:<jobId>` memo. No human approval, no merge — the model reviewer can critique, block with reasons, and request changes, but can never approve.
- **Routing by change kind (Antique-style semantic approvals, via GitHub):** comment/docs-only changes get a light single review; sensitive paths (`.github/`, CI/deploy config, secrets, auth, this classifier) require **CODEOWNERS** approval — GitHub's per-directory IAM; irreversible effects (deploy, migration, force-push) stay parked until their owner approves.
- **Risk classification is deterministic code, not a model judgment** (classifier version in config), run on the **final tree diff**: follows renames/symlinks, inspects content — binaries, lockfiles, secret-like strings, imports of sensitive modules. It routes and labels risk; it never approves and never merges.
- **No pre-merge CI gate, no merge queue.** Branch protection requires approvals (above) but **no required status checks**; GitHub merge queue is off. PR CI runs and is shown in the intent packet as advisory evidence. Landing = squash-merge on intent approval, even while tests are still running — deliberately accepting Anthropic's broken-main windows in exchange for throughput.
- **Post-merge is the real gate:** CI on `main` after every landing (+ pre-deploy tests before any deploy). Failure forks a fix conversation that fixes forwards; fix landings need only a light human intent approval of the fix packet. If `main` stays red past the configured window (default 30 min), the landing task reverts the offending commit and posts the revert + failure. Fix/revert cycles are bounded by the per-job budget and by a human park — **not** by a fixed cycle count (supersedes the earlier max-2 rule).
- **Quality by construction:** workers must ship tests with changes; for infra/concurrency/stateful changes, hermetic simulation or fuzz cases are part of the job definition, and the reviewer critique must call out their absence. There is no separate QA stage.
- **Roles stay separated:** a worker can never review or land its own job; the reviewer is read-only and a different model family than the worker. Humans may steer/abort/veto at any time before merge.
- Draft-branch pushes (`agent/<jobId>`) are exempt from approval, so interrupted work is always recoverable from git. Approvals are memos: first write wins.
3. **Crash/restart:** harness process killed mid-tool → non-safe tool reported `interrupted` to model (never rerun), safe reads replay → systemd restarts the service → `Harness.open(SQLite)` → `resume()` continues from last checkpoint, overdue sleeps fire → duplicate webhook/submit returns original submission.
4. **Steering:** any authorized client submits `whenBusy:"steer"` → lands after current tool round; `abort` cascades to owned subagents, background superfans unaffected.

## 7. Security (non-negotiable, trust boundary)

1. Webhook signature verification on every delivery; reject unsigned.
2. GitHub App, not PAT; short-lived installation tokens; token never logged, never in model-visible args.
3. Web commands require authenticated session; `abort`/veto requires repo-collaborator role. **Landing approval lives on the GitHub PR** (collaborator review; CODEOWNERS for sensitive paths) — the website displays approval state and links to the PR, it does not write approvals. (Supersedes grill-2's website-only approval.) Approvals are memos — first write wins, cannot be silently overwritten.
4. Execution is the RCE boundary: in B all conversations share one VPS, so isolation is per-conversation worktree + a dedicated least-privilege service account (no sudo, no access to auth files of other accounts), egress allowlist (GitHub + model providers only), GitHub token scoped + short-lived, worktree deleted on land/abort. Per-conversation containers are the v2 hardening, accepted as deferred for the proof (§10). Subscription auth files (OpenCode/Pi, Meta Muse) sit in the service account home with `600` perms — they are account credentials, treat accordingly.
5. Reviewer/superfan conversations cannot write, push, or merge — enforced by tool selection, not prompts.
6. All tool args/results treated as untrusted content in UI (escaped, never executed as instructions).

## 8. Acceptance criteria (testable, in build order)

**Phase A — Live site:** Vite console on Pages connects via WSS after GitHub OAuth, renders a real harness transcript; an instruction filed in the UI creates exactly one GitHub issue and one job (its webhook dedupes); late-joining client sees current state + live output; the old simulation is reachable only at `?demo=1`.
**Phase B — Read-only agents:** issue → triage comment posted by agent; `kill -9` the harness mid-run → systemd restart resumes from checkpoint, same `requestId` produces no duplicate comment; overdue sleeping task fires on resume; reviewer cannot invoke `write/bash` (attempt is blocked and logged); worker, reviewer, and triage demonstrably run on their three configured Console models (reviewer a different family than the worker), with no local OpenCode process involved.
**Phase C — Intent-reviewed landings:** PR without human intent approval cannot merge (draft push exempt); approvals survive harness restart; worker/reviewer-model approval attempts do not count as approval; sensitive-path PR without CODEOWNERS approval cannot merge; a PR merges **while its CI is still running or red** once intent-approved (no required checks configured); the intent packet on the PR contains instruction, plan, classifier output, reviewer critique, and test evidence; non-collaborator instruction runs no agent; duplicate webhook never creates a second PR.
**Phase D — Post-merge self-healing:** deliberately broken change landed in a test repo → main CI failure forks a fix conversation, fix lands with light human approval; if main stays red past 30 min the landing is auto-reverted with reasons posted; two conflicting landings are resolved by worker conversations, never a queue; a change without tests (or without simulation/fuzz cases for infra-like changes) is flagged in the reviewer critique; superfan survives main-turn abort; budget breach halts a job and parks it for a human; archived jobs stay retrievable read-only.
General: every phase demoable end-to-end on a throwaway repo before touching a real one.

## 9. Deployment & ops (VPS, architecture B)

- **One VPS:** Caddy (TLS, static console, reverse proxy) + one harness systemd service + `git`. Deploy = build, restart service, `resume()` verifies pending tasks. Never run two harness instances against one storage.
- **Repo settings (applied 2026-10-21 to `vernanng/abc`):** squash-merge only, merge/rebase commits off, delete branch on merge, `CODEOWNERS` for sensitive paths. **Known gap:** the repo is private on GitHub Free, so branch protection (required approvals, no required checks) cannot be enabled — until the repo goes public or the account upgrades, "no merge without intent approval" is enforced by the harness approval hook (C5) alone, not by GitHub. A human merging manually in the GitHub UI can bypass it; accepted for proof, recorded here.
- **Models on the box:** none. The harness service is a Node process with `@earendil-works/pi-durable` + `pi-ai` (provider `opencode`) as library dependencies; the only model credential is `OPENROUTER_API_KEY` in its env. Role routing per §5. OpenRouter rate limits are shared by all jobs — concurrent workers are capped in config (default 2) to avoid self-throttling.
- **Backups:** scheduled copy of harness SQLite + worktree index off-box (R2/`rclone`); restore test (fresh dir from backup, `resume()`, verify transcript) is part of Phase B exit criteria.
- **Observability:** structured log per submission ID (journald); `task_parked`/`task_faulted`/`task_outdated` reports surfaced in UI; parked tasks list + `retryTask` action (PLAN Phase 4). No dollar metering exists for any role; usage is tracked as sessions/tokens-reported-by-CLI/time only (§10).
- **Rollback:** redeploy previous build; harness state is never rolled back (forward-only — fix with a new registry version, or restore storage from backup and `resume()`).
- **v2 trigger (Cloudflare):** proof succeeds and one VPS saturates (CPU, disk, or subscription rate limits) → move harness to one DO per repo + Containers per the earlier grill-2 design; the §5 ExecEnv seam and draft-branch discipline make execution portable.

## 10. Risks / open questions

| Risk | Mitigation / decision needed |
|---|---|
| Pi Durable API is experimental, changes without notice | Pin exact version; all usage behind our registry/extensions layer; upgrade = deliberate task, not auto |
| Single VPS = single point of failure + shared subscription quota | Accepted for proof (architecture B); v2 trigger in §9. Worker concurrency capped (default 2) |
| OpenRouter is the single model provider | All roles share one key/catalog; an OpenRouter outage hits all roles together. Family separation (§6.1) is by model choice inside one provider. Key in harness env only; rotation = env change + restart. (OpenCode Console rejected after live proof: free tier app-locked to the official client, key had no paid/Go access.) |
| Budget metering: OpenRouter is the dollar meter | Per-call usage/cost from OpenRouter feeds C9; BUDGET_*_USD caps are enforceable again |
| Public webhook + local `bash` = RCE by design | §7 controls are launch blockers, not Phase-4 items; per-worktree service account now, per-conversation containers in v2 |
| ~100 ms progress-commit window | Only affects streamed output loss on crash; correctness state is checkpointed per task |
| ~~Open: who may approve?~~ Resolved then **superseded by §6.1 realignment**: human intent review on every landing | Done |
| Grill resolutions 2026-10-21 (all in §3–§8) | Collaborators-only instruction; final-tree-diff + content-scan classifier; draft branch exempt from gate; no re-review on landing conflicts; cold jobs archived. **Superseded in part by §6.1 realignment below:** PR-CI-as-gate, max-2 fix cycles, 10% spot-check, model approval | Done |
| Anthropic realignment 2026-10-21 (§6.1) | Human intent review on **every** landing (GitHub PR approval; CODEOWNERS = per-directory IAM); model reviewer adversarial only; no required status checks, no merge queue; post-merge CI + pre-deploy tests are the gate; fix-forwards with auto-revert after 30 min red; tests + simulation/fuzz ship with changes; website no longer approves | Done |
| ~~Open: model/provider per role~~ Resolved 2026-10-21 (architecture B) | All roles via OpenRouter API (Console key abandoned after live proof, 2026-10-21); worker `deepseek/deepseek-v4.1-flash`, reviewer `z-ai/glm-5.3-flash`, triage `minimax/minimax-m3` |
| ~~Open: keep demo simulation on the public site?~~ Resolved grill 2: `?demo=1` only | Done |
| Grill 2 resolutions 2026-10-21 (website + execution env) | Vite + React/Preact console; console files instructions via GitHub issue (webhook dedupes); GitHub OAuth with live collaborator check; partial + sparse clone. Execution host superseded by architecture B; approval surface superseded by §6.1 realignment (GitHub PR review) | Done |
| Architecture B 2026-10-21 | Single VPS proof: harness + OpenCode/Pi CLIs + local worktrees; all roles via OpenRouter API; Cloudflare DO/Containers deferred to v2 (§9) | Done |

## 11. Out of scope for v1 (do not build)

Scion/changeset VCS, blob caches, merge queue, multi-repo tenancy, HA/failover, per-directory IAM, distributed storage, mobile UI, billing/quotas per user.
