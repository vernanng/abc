# SPEC: Scion-style vibe coding on Pi Durable + GitHub

Status: draft, pre-implementation. Source plan: `PLAN.md`. Demo: `index.html` (simulation only).
Rule: no code beyond the demo until this spec is accepted. Changing a requirement = edit this file first.

## 1. Goal / Non-goals

**Goal:** A hosted web app where multiple users assign coding work to durable agents that operate on one GitHub repo: agents survive crashes/restarts, work in parallel without blocking each other, merge normal work on model approval with humans only instructing and approving high-risk actions, and auto-fork a fix conversation when post-merge CI fails.

**Non-goals (explicit, until measured need):** new VCS/changeset store, merge queue, multi-repo support, multi-machine/sharded harness, Kubernetes, per-directory IAM engine, virtual filesystem, billing.

## 2. Principles (from PLAN.md §2, binding)

1. Git stays; only the workflow is borrowed from Scion.
2. Work unit = durable conversation fork, not a long-lived branch. Sole exception: the PR branch.
3. Humans only give instructions (build this feature) and approve high-risk actions (§6.1). Everything else — intent, implementation, merge — is model-approved.
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
                                            ├─ Worker/reviewer/triage = OpenCode / Pi CLI subprocesses
                                            │    worker: Meta Muse subscription · reviewer: OpenRouter · triage: free model via OpenCode
                                            └─ WebSocket: watch() ops / viewState()
Web clients ──HTTPS/WSS──▶ Caddy ──▶ console (static) + harness service
GitHub App ◀── REST (installation token) ── harness service (PR create/merge/comment)
                    └──────────────────────────────────────────────────────────────────────────────────────┘
Deferred v2: Cloudflare Durable Object per repo + Cloudflare Containers (grill-2 design) — only if the proof outgrows one VPS. The ExecEnv seam (§5) is where execution moves; harness state moves DO-side at that point.
```

- **Site:** Vite + React/Preact console (grill 2), served by Caddy on the VPS for the proof (Pages is a later static split, no code change). The vanilla `index.html` simulation survives only behind `?demo=1`. The site is an **ops console + instruction entry point**: filing a feature in the UI creates the GitHub issue (single source of truth) and submits its ID as the job `requestId` — the webhook for that same issue dedupes against it, so UI-first and GitHub-first instructions converge on one job.
- **Harness host: one VPS (architecture B).** Single systemd service owns the SQLite storage on local disk — that process *is* the single owner Pi Durable requires. Restart (crash, deploy, reboot) = service restarts, `harness.resume()` continues from checkpoints. No second instance may ever open the same storage.
- **Wake contract:** no DO alarms in B. Sleeping tasks use Pi Durable's stored sleeps + process timers (`setTimer`/`now` defaults); a stopped service simply fires overdue sleeps on `resume()`. (The binding DO alarm contract returns in v2.)
- **Execution is local:** one git worktree per conversation on the VPS, agents run as OpenCode/Pi CLI subprocesses inside it. VPS compromise or disk loss must never lose code state: worktrees are rebuildable from git + the durable transcript; unlanded work is pushed to the job's **draft branch** (`agent/<jobId>`, exempt from the approval gate — §6.1) before any long pause. The gate applies to PR-open and merge, never to draft pushes.

## 4. Components

| # | Component | Responsibility | Pi Durable primitive |
|---|---|---|---|
| C1 | Ingress | Verify GitHub webhook signature; map delivery → submission | `submit({requestId: deliveryId})` |
| C2 | Dispatcher (root) | Triage input, fork task conversations, report status to issue/PR | `fork(entryId)`, subagent tool pattern (ex. 22/23) |
| C3 | Worker conversation | Implement one job in its own local worktree; run tests | per-conversation `cwd` + `NodeExecutionEnv`, `CodingTools`; agent = OpenCode/Pi CLI on Meta Muse subscription |
| C4 | Reviewer conversation | Read-only review of plan + diff; posts verdict doc | `configure({tools:{remove:[write,edit,bash]}})`, cheap model |
| C5 | Approval gate + risk classifier | Classify every push/merge (§6.1): normal → reviewer model approves; high-risk → parked for human. Decisions survive restart | deterministic classifier + `hook(ToolTask,{beforeTool})` + `api.memo("approval:<jobId>")` / `api.memo("approval-human:<jobId>")` |
| C6 | Landing task | Serialize PR merge; run post-merge verification; on failure fork fix conversation + comment on PR | `defineTask` phases `land → verify`, `background:true` verify |
| C7 | Superfan (×N) | Tail CI/test logs; steer main conversation only on anomaly | background ownerless conversation, `replay:"safe"` log tool |
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
**Model routing (B):** worker = Pi/OpenCode on the operator's **Meta Muse subscription**; reviewer = **OpenRouter API** (different model family from the worker — this is also the independence mechanism for §6.1); triage = a **free model routed through OpenCode**. All three share the VPS; per-role model IDs live in config (§5 Config), never in code.

**Web client protocol:** WSS to Caddy → harness service → snapshot (`viewState`) then commit ops (`watch`). Client commands: `instruct` (creates GitHub issue + job), `submit` (follow-up/steer), `approve(jobId)` (high-risk only, §6.1 — **website is the only human approval surface**, decided grill 2), `abort(conversationId)`. Auth: **GitHub OAuth**; collaborator status checked live against the repo on each command, never cached into a local role table.

**Config (env file on the VPS, no code changes):** `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, `REPO` (single `owner/name`), `OPENROUTER_API_KEY`, model IDs per role (`WORKER_MODEL`, `REVIEWER_MODEL`, `TRIAGE_MODEL`), CLI selector per role (`AGENT_CLI=opencode|pi`), per-conversation budget, storage/worktree paths. Subscription auth files for OpenCode/Pi live in the service account's home — never in the repo or env file.

## 6. Key flows

1. **New job:** collaborator files instruction only → C1 dedupes + authorizes → root submits → triage (cheap) → fork worker + reviewer in parallel, each own worktree → worker writes plan doc → **reviewer model approves intent (§6.1)** → worker implements → draft pushes to `agent/<jobId>` (ungated) → PR opened.
2. **Landing:** C5 risk-classifies the final tree diff → normal: reviewer model approves **and GitHub CI on the PR is green** (the only test gate; there is no local-test requirement) → high-risk: parked for human approval regardless of CI → C6 squash-merges to `main`, deletes worktree/branch → background post-merge verify → fail ⇒ fix conversation forked with failure output, comment posted, no human triage. Parallel jobs that conflict on landing are *not* re-reviewed (Scion-style merge-fast, fix-forwards); broken-main windows are bounded by the §6.1 fix-loop cap.

### 6.1 Approval policy (binding)
- **Human role: instruction only.** A human files the feature request (issue/UI) and approves high-risk actions. Humans do not approve plans, diffs, or normal merges.
- Approver = reviewer conversation (C4), read-only, **different conversation than the worker**; a worker can never approve its own job.
- **Risk classification is deterministic code, not a model judgment** (classifier version in config), run on the **final tree diff** (not the commit diff): it follows renames/symlinks, and inspects content — binary and lockfile changes, secret-like strings, and imports of sensitive modules from benign paths all count (decided 2026-10-21). High-risk if any holds:
  - change touches a sensitive path: `.github/`, CI/deploy config, secrets handling, auth code, this approval/classifier code (list in config);
  - action is an external/irreversible effect: deploy, data migration/deletion, force-push, dependency with install scripts, or spend above the per-job budget;
  - diff exceeds configured size (default 1,000 changed lines) or deletes more than it adds by 5×.
  The classifier may only escalate or pass to the reviewer; it never approves.
- **Normal risk:** reviewer model approves only if plan matches the instruction, verdict doc states `approve` with reasons, **and GitHub CI checks on the PR pass** (decided 2026-10-21: PR CI is the sole test gate — no repo CI, no auto-merge; the job parks for a human). Rejection returns reasons; max **2** loops, then park + post state.
- **Auto-fix bound:** post-merge CI failure forks a fix conversation (§6 flow 2); at most **2** fix-merge cycles per original job, then the job parks with full history posted. No loop is bounded by budget alone.
- **Human spot-check:** a deterministic 10% sample (hash of job ID) of normal merges is flagged for after-the-fact human audit in the UI. Findings can trigger a revert job (a new instruction, normal flow). This is an audit trail, not a gate — it never blocks a merge.
- **High-risk:** job parks *before* the effect; a human approves/rejects in the UI (`approval-human:<jobId>` memo). No model approval substitutes. Human `abort`/veto overrides at any time before merge.
- Approvals are memos: first write wins, cannot be silently overwritten. Draft-branch pushes (`agent/<jobId>`) are exempt from approval, so interrupted work is always recoverable from git.
3. **Crash/restart:** harness process killed mid-tool → non-safe tool reported `interrupted` to model (never rerun), safe reads replay → systemd restarts the service → `Harness.open(SQLite)` → `resume()` continues from last checkpoint, overdue sleeps fire → duplicate webhook/submit returns original submission.
4. **Steering:** any authorized client submits `whenBusy:"steer"` → lands after current tool round; `abort` cascades to owned subagents, background superfans unaffected.

## 7. Security (non-negotiable, trust boundary)

1. Webhook signature verification on every delivery; reject unsigned.
2. GitHub App, not PAT; short-lived installation tokens; token never logged, never in model-visible args.
3. Web commands require authenticated session; `abort`/veto and high-risk `approve` require repo-collaborator role. Normal approvals are model-only — no web approve path exists for them. Approvals are memos — first write wins, cannot be silently overwritten.
4. Execution is the RCE boundary: in B all conversations share one VPS, so isolation is per-conversation worktree + a dedicated least-privilege service account (no sudo, no access to auth files of other accounts), egress allowlist (GitHub + model providers only), GitHub token scoped + short-lived, worktree deleted on land/abort. Per-conversation containers are the v2 hardening, accepted as deferred for the proof (§10). Subscription auth files (OpenCode/Pi, Meta Muse) sit in the service account home with `600` perms — they are account credentials, treat accordingly.
5. Reviewer/superfan conversations cannot write, push, or merge — enforced by tool selection, not prompts.
6. All tool args/results treated as untrusted content in UI (escaped, never executed as instructions).

## 8. Acceptance criteria (testable, in build order)

**Phase A — Live site:** Vite console on Pages connects via WSS after GitHub OAuth, renders a real harness transcript; an instruction filed in the UI creates exactly one GitHub issue and one job (its webhook dedupes); late-joining client sees current state + live output; the old simulation is reachable only at `?demo=1`.
**Phase B — Read-only agents:** issue → triage comment posted by agent; `kill -9` the harness mid-run → systemd restart resumes from checkpoint, same `requestId` produces no duplicate comment; overdue sleeping task fires on resume; reviewer cannot invoke `write/bash` (attempt is blocked and logged); worker runs on Muse subscription, reviewer verdict demonstrably comes from the OpenRouter model, triage from the free model.
**Phase C — Gated PRs:** unapproved PR-open/merge blocked (draft push exempt), block + approvals survive harness restart; worker self-approval rejected; a rename of a sensitive file into a benign path is still classified high-risk; non-collaborator instruction runs no agent; normal job merges with zero human action after the instruction *only with green PR CI* (no CI configured ⇒ parks); a high-risk change parks and the model cannot override that park; a job rejected twice parks with reasons posted; duplicate webhook never creates a second PR.
**Phase D — Self-healing:** deliberately broken change merged in a test repo → failed CI forks a fix conversation and posts diagnosis without human input; after 2 failed fix cycles the job parks instead of looping; two same-file jobs landing in sequence leave main green or parked, never silently broken; 10% spot-check flags appear in the UI; superfan survives main-turn abort; per-conversation budget breach halts the run and reports; a landed job archived to R2 after TTL is still retrievable read-only.
General: every phase demoable end-to-end on a throwaway repo before touching a real one.

## 9. Deployment & ops (VPS, architecture B)

- **One VPS:** Caddy (TLS, static console, reverse proxy) + one harness systemd service + `git`. Deploy = build, restart service, `resume()` verifies pending tasks. Never run two harness instances against one storage.
- **Agents on the box:** OpenCode + Pi CLIs installed for the service account; Meta Muse subscription logged in once interactively (auth file in service home); OpenRouter key in env. Role routing per §5. Subscription quota is shared by all worker jobs — concurrent workers are capped in config (default 2) to avoid self-throttling.
- **Backups:** scheduled copy of harness SQLite + worktree index off-box (R2/`rclone`); restore test (fresh dir from backup, `resume()`, verify transcript) is part of Phase B exit criteria.
- **Observability:** structured log per submission ID (journald); `task_parked`/`task_faulted`/`task_outdated` reports surfaced in UI; parked tasks list + `retryTask` action (PLAN Phase 4). OpenRouter spend is metered per call; Muse/free-model usage is tracked as sessions/time only (§10).
- **Rollback:** redeploy previous build; harness state is never rolled back (forward-only — fix with a new registry version, or restore storage from backup and `resume()`).
- **v2 trigger (Cloudflare):** proof succeeds and one VPS saturates (CPU, disk, or subscription rate limits) → move harness to one DO per repo + Containers per the earlier grill-2 design; the §5 ExecEnv seam and draft-branch discipline make execution portable.

## 10. Risks / open questions

| Risk | Mitigation / decision needed |
|---|---|
| Pi Durable API is experimental, changes without notice | Pin exact version; all usage behind our registry/extensions layer; upgrade = deliberate task, not auto |
| Single VPS = single point of failure + shared subscription quota | Accepted for proof (architecture B); v2 trigger in §9. Worker concurrency capped (default 2) |
| Muse subscription used headlessly/automated | Proof only. Consumer subscription terms + rate limits may not permit this at scale; production path is API keys. VPS compromise = subscription account compromise (§7.4) |
| Budget guard is approximate for subscription/free models | OpenRouter (reviewer) is metered in dollars; worker/triage tracked as sessions/time. Dollar caps bind only where metering exists |
| Public webhook + local `bash` = RCE by design | §7 controls are launch blockers, not Phase-4 items; per-worktree service account now, per-conversation containers in v2 |
| ~100 ms progress-commit window | Only affects streamed output loss on crash; correctness state is checkpointed per task |
| ~~Open: who may approve?~~ Resolved 2026-10-21: humans give instructions only; reviewer model approves normal work, humans approve high-risk only (§6.1) | Done |
| Grill resolutions 2026-10-21 (all in §3–§8) | Collaborators-only instruction; final-tree-diff + content-scan classifier; draft branch exempt from gate; no re-review on landing conflicts (fix-forwards, §6.1 cap); max 2 auto-fix cycles; PR CI is the sole test gate; 10% human spot-check audits; cold jobs archived to R2 | Done |
| ~~Open: model/provider per role~~ Resolved 2026-10-21 (architecture B) | Worker = Meta Muse subscription; reviewer = OpenRouter (exact model ID to `.env` before Phase B); triage = free model via OpenCode routing. Dollar budget binds OpenRouter; subscription roles capped by concurrency/time |
| ~~Open: keep demo simulation on the public site?~~ Resolved grill 2: `?demo=1` only | Done |
| Grill 2 resolutions 2026-10-21 (website + execution env) | Vite + React/Preact console; console files instructions via GitHub issue (webhook dedupes); GitHub OAuth with live collaborator check; website is the sole human approval surface; partial + sparse clone. Execution host superseded by architecture B (below); DO+Containers retained as v2 | Done |
| Architecture B 2026-10-21 | Single VPS proof: harness + OpenCode/Pi CLIs + local worktrees; worker Muse subscription, reviewer OpenRouter, triage free via OpenCode; Cloudflare DO/Containers deferred to v2 (§9) | Done |

## 11. Out of scope for v1 (do not build)

Scion/changeset VCS, blob caches, merge queue, multi-repo tenancy, HA/failover, per-directory IAM, distributed storage, mobile UI, billing/quotas per user.
