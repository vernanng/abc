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
GitHub repo ──webhook──▶ Cloudflare Worker (ingress, signature verify, auth)
                            │ RPC
                            ▼
                         RepoSession — one Durable Object per repo
                            │  Pi Durable: Harness.open(openDurableObjectSqliteStorage(ctx.storage))
                            │  onWake → ctx.storage.setAlarm(); alarm() → harness.resume()
                            │  ├─ root conversation (triage/dispatch)
                            │  ├─ task conversations (1 per job)
                            │  ├─ reviewer conversation (read-only, cheap model)
                            │  └─ superfan conversations (background, ownerless)
                            ├─ Remote execution env per conversation (separate service: git clone/worktree, bash)
                            └─ WebSocket (hibernatable): watch() ops / viewState()
Web clients (static site on Cloudflare Pages) ──WSS──▶ Worker ──▶ RepoSession
GitHub App ◀── REST (installation token) ── Worker/DO (PR create/merge/comment)
```

- **Site:** existing `index.html` on Cloudflare Pages; simulation log replaced by live `watch()` feed. No agent code runs there.
- **Harness host: Cloudflare Durable Objects (decided 2026-10-21).** One `RepoSession` DO per GitHub repo (`idFromName(owner/name)`), SQLite storage inside the DO. The DO *is* the single owner Pi Durable requires — no volume, no instance pinning.
- **Wake contract (binding, from Pi Durable README):** arm the DO alarm *before* any call that can start work (`submit`, `compact`, `abort`, registry change); `onWake` reports `active` / earliest sleep; `alarm()` re-arms then calls `harness.resume()`. A missing alarm strands sleeping/interrupted work; an early alarm is harmless. Recovery heartbeat ≤ 60 s while work is active.
- **Execution is NOT in the DO.** Workers/DOs have no repo filesystem or `bash`. Every tool call goes through a remote execution env (§5) — a small stateless service (Cloudflare Container per conversation, or equivalent sandbox host) that owns the clone/worktree. DO eviction must never lose code state: worktrees are rebuildable from git + the durable transcript; unlanded work is pushed to the job's **draft branch** (`agent/<jobId>`, exempt from the approval gate — §6.1) before any long pause. The gate applies to PR-open and merge, never to draft pushes.

## 4. Components

| # | Component | Responsibility | Pi Durable primitive |
|---|---|---|---|
| C1 | Ingress | Verify GitHub webhook signature; map delivery → submission | `submit({requestId: deliveryId})` |
| C2 | Dispatcher (root) | Triage input, fork task conversations, report status to issue/PR | `fork(entryId)`, subagent tool pattern (ex. 22/23) |
| C3 | Worker conversation | Implement one job in its own remote worktree; run tests | per-conversation `cwd` + remote `ExecutionEnv` (pi-env `RemoteExecutionEnv` pattern), `CodingTools` |
| C4 | Reviewer conversation | Read-only review of plan + diff; posts verdict doc | `configure({tools:{remove:[write,edit,bash]}})`, cheap model |
| C5 | Approval gate + risk classifier | Classify every push/merge (§6.1): normal → reviewer model approves; high-risk → parked for human. Decisions survive restart | deterministic classifier + `hook(ToolTask,{beforeTool})` + `api.memo("approval:<jobId>")` / `api.memo("approval-human:<jobId>")` |
| C6 | Landing task | Serialize PR merge; run post-merge verification; on failure fork fix conversation + comment on PR | `defineTask` phases `land → verify`, `background:true` verify |
| C7 | Superfan (×N) | Tail CI/test logs; steer main conversation only on anomaly | background ownerless conversation, `replay:"safe"` log tool |
| C8 | Web client | Live transcript/tool output, steer, approve, abort; late join from current view | `viewState()` / `watch()` over WSS |
| C9 | Budget guard | Per-conversation spend cap; stop runaway runs | `pi.usage` doc + `onYield` hook |

State that must be durable (all in DO SQLite storage, none in process memory): transcripts, submissions/`requestId`s, plan & review docs (`defineDoc`, `fork:"asOf"`), approval memos, task checkpoints, usage. Files/code live only in per-conversation remote worktrees + git; a worktree is a cache, never the source of truth. **Retention:** landed/aborted jobs are archived to R2 after a configured TTL (default 30 days) — the DO keeps live jobs plus an index (job ID, outcome, R2 key); archived transcripts are read-only via the archive, never reloaded into the DO.

## 5. Interfaces

**Inbound (GitHub App webhooks, signature-verified):** `issues.opened/edited`, `issue_comment.created` (`@agent …`), `pull_request_review_comment`, `check_run.completed` / Actions failure, `pull_request.closed`. Each handler: dedupe by delivery ID, then `submit()`; unrecognized events are acked `200` and dropped. **Instruction authorization:** only repo collaborators may instruct (decided 2026-10-21). A non-collaborator issue/comment gets one refusal comment and runs no agent, forks no conversation, and spends no budget.

**Outbound (GitHub REST, installation token, least scope):** read issue/PR, create/update PR, comment, request review, merge (squash only). Token is injected into the execution env / API client; never present in tool arguments or transcript text.

**Tools (per conversation, selected by role):**
- Worker: `read, write, edit, bash, search_history` + `gh_read` (`replay:"safe"`), `push_draft` (non-safe, ungated — draft branch only), `open_pr`, `merge` (both non-safe, gated by C5).
- Reviewer: `read, gh_read` only.
- Superfan: `tail_logs` (`replay:"safe"`) + `submit(steer)` to main.

**Remote execution env contract (per conversation):** `read/write/edit/listFiles`, `exec(argv)` with streamed output, working dir = that conversation's clone (sparse checkout of the repo at the job base commit). One env per conversation, stable `id` per conversation so equal IDs see the same files. Hosted outside the DO (Cloudflare Container per conversation preferred; any sandbox host implementing the contract is acceptable). Env is disposable: destroy on land/abort; recreate from git on resume.

**Web client protocol:** WSS to the Worker, forwarded to the `RepoSession` DO (hibernatable WebSockets; state rebuilt from `viewState` on wake) → snapshot then commit ops (`watch`). Client commands: `submit` (follow-up/steer), `approve(jobId)` (high-risk only, §6.1), `abort(conversationId)`. Auth required for commands (§7).

**Config (Worker vars/secrets, no code changes):** `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `WEBHOOK_SECRET`, `REPO` (single `owner/name`), model IDs per role, per-conversation token budget, execution-env endpoint/token. No storage path — DO SQLite is addressed by repo name.

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
3. **Crash/eviction:** DO evicted mid-tool → non-safe tool reported `interrupted` to model (never rerun), safe reads replay → alarm (armed before work started, §3) wakes a new DO instance → `Harness.open(openDurableObjectSqliteStorage(...))` → `resume()` continues from last checkpoint → duplicate webhook/submit returns original submission.
4. **Steering:** any authorized client submits `whenBusy:"steer"` → lands after current tool round; `abort` cascades to owned subagents, background superfans unaffected.

## 7. Security (non-negotiable, trust boundary)

1. Webhook signature verification on every delivery; reject unsigned.
2. GitHub App, not PAT; short-lived installation tokens; token never logged, never in model-visible args.
3. Web commands require authenticated session; `abort`/veto and high-risk `approve` require repo-collaborator role. Normal approvals are model-only — no web approve path exists for them. Approvals are memos — first write wins, cannot be silently overwritten.
4. Execution env is the RCE boundary: one isolated container/sandbox per conversation (never shared, never inside the DO), egress allowlist (GitHub + model provider only), env receives only a short-lived scoped GitHub token, destroyed on land/abort. The DO itself never executes repo code.
5. Reviewer/superfan conversations cannot write, push, or merge — enforced by tool selection, not prompts.
6. All tool args/results treated as untrusted content in UI (escaped, never executed as instructions).

## 8. Acceptance criteria (testable, in build order)

**Phase A — Live site:** deployed page connects via WSS, renders a real harness transcript; late-joining client sees current state + live output. Demo simulation removed or behind `?demo=1`.
**Phase B — Read-only agents:** issue → triage comment posted by agent; evict/reset the DO mid-run (and disable its timers) → alarm-driven wake resumes, same `requestId` produces no duplicate comment; sleeping task fires via alarm, not a process timer; reviewer cannot invoke `write/bash` (attempt is blocked and logged).
**Phase C — Gated PRs:** unapproved PR-open/merge blocked (draft push exempt), block + approvals survive DO eviction; worker self-approval rejected; a rename of a sensitive file into a benign path is still classified high-risk; non-collaborator instruction runs no agent; normal job merges with zero human action after the instruction *only with green PR CI* (no CI configured ⇒ parks); a high-risk change parks and the model cannot override that park; a job rejected twice parks with reasons posted; duplicate webhook never creates a second PR.
**Phase D — Self-healing:** deliberately broken change merged in a test repo → failed CI forks a fix conversation and posts diagnosis without human input; after 2 failed fix cycles the job parks instead of looping; two same-file jobs landing in sequence leave main green or parked, never silently broken; 10% spot-check flags appear in the UI; superfan survives main-turn abort; per-conversation budget breach halts the run and reports; a landed job archived to R2 after TTL is still retrievable read-only.
General: every phase demoable end-to-end on a throwaway repo before touching a real one.

## 9. Deployment & ops (Cloudflare)

- **Site:** Cloudflare Pages, static deploy on push to `main`.
- **Harness:** one Worker + `RepoSession` Durable Object class (SQLite storage), `wrangler deploy`. DO naming: `idFromName("owner/name")` — one DO per repo is the sharding strategy; multi-repo = more DOs, no code change.
- **Deploy:** Worker deploy replaces code while the DO hibernates/evicts; on next wake the new process reinstalls the same extensions in the registry and `resume()` picks up pending tasks (conversations store extension *names*, not code). No drain needed; never run two registry-incompatible versions against live tasks without checking `task_outdated` reports first.
- **Execution env service:** deployed separately (Cloudflare Containers preferred, same account); scale/lifecycle independent of the DO. Env creation failure = tool error result, never a DO crash.
- **Backups:** scheduled export of DO storage (commits/transcript snapshot) to R2 from a cron Worker; restore test (new DO from export, `resume()`, verify transcript) is part of Phase B exit criteria.
- **Observability:** structured log per submission ID (Workers Logs); `task_parked`/`task_faulted`/`task_outdated` reports surfaced in UI; parked tasks list + `retryTask` action (PLAN Phase 4). Alarm health: report last `onWake` state; a DO with active work and no alarm armed is an alert.
- **Rollback:** site/Worker = redeploy previous version; harness state is never rolled back (forward-only — fix with a new registry version, or restore DO from R2 export as a new DO and repoint).

## 10. Risks / open questions

| Risk | Mitigation / decision needed |
|---|---|
| Pi Durable API is experimental, changes without notice | Pin exact version; all usage behind our registry/extensions layer; upgrade = deliberate task, not auto |
| Single DO per repo = throughput ceiling for that repo | Accepted: DOs scale by repo, not within one. Trigger to revisit: one repo saturating a DO's CPU/storage |
| Missing/mis-armed DO alarm strands work silently | §3 wake contract + alarm-health alert (§9); acceptance test in Phase B with timers disabled |
| Public webhook + remote `bash` = RCE by design | §7 controls are launch blockers, not Phase-4 items; execution stays outside the DO in per-conversation sandboxes |
| ~100 ms progress-commit window | Only affects streamed output loss on crash; correctness state is checkpointed per task |
| ~~Open: who may approve?~~ Resolved 2026-10-21: humans give instructions only; reviewer model approves normal work, humans approve high-risk only (§6.1) | Done |
| Grill resolutions 2026-10-21 (all in §3–§8) | Collaborators-only instruction; final-tree-diff + content-scan classifier; draft branch exempt from gate; no re-review on landing conflicts (fix-forwards, §6.1 cap); max 2 auto-fix cycles; PR CI is the sole test gate; 10% human spot-check audits; cold jobs archived to R2 | Done |
| Open: model/provider + budget defaults per role | Decide before Phase B; store as config, not code. Approver model must be named here before Phase C |
| Open: keep demo simulation on the public site? | Default `?demo=1` only (Phase A) |

## 11. Out of scope for v1 (do not build)

Scion/changeset VCS, blob caches, merge queue, multi-repo tenancy, HA/failover, per-directory IAM, distributed storage, mobile UI, billing/quotas per user.
