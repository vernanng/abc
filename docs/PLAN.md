# Vibe-coding setup: Anthropic's Scion workflow, rebuilt on Pi Durable (not a Scion clone)

> **Historical — 2026-10-21 source plan, kept as background.** The system in this plan has been built: all phases (0, 1, A–D) are proven and the harness is live on a Linux VPS (see `README.md` for current state and `docs/SPEC.md` for the binding spec). Details below that describe pre-build choices (e.g. hosting, model picks, approval design) may be superseded there — do not use this file as an ops reference.

## 1. Proof (REA, 2026-10-21)

Scion is internal/closed — no binary exists to reverse. Proof is documentary, captured live in a browser, not scraped from memory:

| Claim source | REA evidence | Confidence |
|---|---|---|
| Anthropic post renders, full text captured | `ev_4470bf6324a85cd16289914727980f92ea8ed1d64399683bc444aaf074092667`, DOM sha256 `e7646d07df9ad378138786fa672ac426f4413f64e541bb9cea4f22c2d5d93fe2` (255,612 B), Chromium 155 via Brave | observed / controlled-replay |
| Pi Durable post renders (`checkpoint`, `fork` present in DOM) | `ev_bd32a16bc0020ecda214cdad511bd8e08deb6f255731c1ab6e66a0f72b3480d1`, DOM sha256 `d2069382c67cf79d7cc04769f5f5228627c49f87aaca6d889070b51fec75290c` (88,417 B) | observed / controlled-replay |
| Pi Durable API is real, not blog-only | `github.com/earendil-works/pi/packages/durable/README.md` fetched raw: `Harness.open`, `root()`, `submit(requestId)`, `fork(entryId)`, `defineTask`, `defineDoc`, examples `22-subagent-foreground.ts` / `23-subagent-background.ts`. Marked **experimental, API changes without notice** | observed |

Limitation: REA proves what Anthropic *published*, not their internal deployment. Treat numbers below as Anthropic's self-report.

## 2. How Anthropic actually works (the workflow, not the VCS)

Scale forcing function: ~2,500 merges/day (May 2026) → >30,000/day (Sep 2026); ~25M checkouts/day; main history ~100 GB, working copy >25 GB. Bottleneck moved from writing code to source control / builds / CI.

The loop, extracted from the post:

1. **Agents are always online; the server does the work.** Commits, merges, rebases, diff, blame happen server-side. Client keeps a bounded cache + sparse/virtual checkout. Most jobs never check out at all — they call APIs (diff, merge-base, bisect, revert).
2. **Unit of work = changeset, not branch.** A changeset is a write-ahead-log entry: changed files vs first parent + content-addressed blobs. Created server-side, instantly visible everywhere, cost ∝ change size, lock-free. Refs (branches/tags) are *discouraged* — global state every server must agree on is the scaling problem. Only `main` + release branches matter.
3. **Derived data is recursive and lazy/eager by choice.** Blame, path history, commit-graph skip lists are computed from parents via one generic mechanism; new indices are added without changing the client.
4. **Review reviews intent, not lines (Antique).** Humans still review every change, but examine *intent*. Semantic approval rules separate comment-only changes from sensitive logic; per-directory IAM focuses humans on consequential code. Adversarial review is used but humans steer agents away from over-engineering and constraint violations ("tell Claude no").
5. **No global merge queue.** A repo-wide lock doesn't survive hundreds of merges landing while tests run. Instead: post-merge + pre-deploy automated testing; concurrent conflicts are fixed by Claude faster than humans can identify them.
6. **Superfans.** One Claude per component (scion-daemon, scion-cache, merge queue…) in Slack, watching telemetry/logs full-time, catching subtle/novel issues alerts miss.
7. **Quality by simulation.** Hermetic simulations of every non-trivial interaction, fuzzing, rate limiting — feasible only because agents write the tests.
8. **Small team, huge leverage.** 7 people built Scion + Antique + ~6 related systems and migrated in 5 months while merge volume grew 10×.

What to *not* copy: a new VCS, Spanner backend, changeset store, tiered blob caches (200× infra win only matters at 25M checkouts/day), virtualized filesystem. Keep git.

## 3. Mapping: Scion workflow → Pi Durable primitives

| Scion / Antique concept | Pi Durable equivalent (git stays) |
|---|---|
| Always-reachable server, API-first, no local repo needed | One `Harness.open(sqlite)` process owns storage; clients attach via `viewState()` / `watch()`. Harness is source of truth for agent state; git only stores landed code |
| Changeset: cheap, atomic, instantly visible, ∝ change | Pi **Commit**: atomic entries+docs+tasks. `submit({requestId})` is exactly-once — retry after crash returns the original submission |
| Refs discouraged; work is a delta on main | **Conversation fork at an entry**, not a git branch. One short-lived `git worktree` per conversation; land = squash to `main`, delete worktree |
| Sparse/virtual checkout, working copy optional | Per-conversation `cwd` + `env({cwd}) => new NodeExecutionEnv(...)`; `git sparse-checkout` per worktree. Diff/blame-only jobs use `env.exec(["git",...])`, no agent checkout |
| Derived data, recursive, add indices freely | `defineDoc` (plan, todos, review state; `fork: "asOf"`), compaction summaries, `search_history` tool over old entries |
| Antique semantic approvals, per-directory IAM | `hook(ToolTask, {beforeTool})` with `api.memo` (first-write-wins approval, survives restart); per-conversation `configure({tools:{remove:[deploy]}})`, read-only reviewer on a cheaper model |
| Intent review, "tell it no" | Human reviews the *submission + plan doc*, steers with `submit({whenBusy:"steer"})`; `onYield` hook keeps a run going only if checks pass |
| No merge queue → post-merge testing, agent fixes conflicts | One **landing task** serializes pushes (the only lock). Post-merge test is a `background:true` task; failure forks a fix conversation automatically |
| Superfans per component | Background, ownerless subagent conversations (example 23 pattern) watching test/log output; they post follow-ups to main and survive Esc/abort of the main turn |
| Crash-proof infra, hermetic simulation | Every step is a checkpointed **Task**; `replay:"safe"` only for reads. Non-safe tools are never rerun — model is told `interrupted` |
| Malleable running system | `registry.install()` hot-replaces an extension by name; running calls finish on old code, next call uses new |
| Long runs | Background compaction + `reset(handoff)` / `control:{handoff}`; nothing is deleted, old context stays searchable |

## 4. Build plan

### Phase 0 — Prove durability (spike)
- `npm i @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord`; `Harness.open(openNodeSqliteStorage("./agent.sqlite"))`, install `CodingTools`.
- Root conversation with `cwd` = this repo. Submit a coding task with a fixed `requestId`.
- **Acceptance:** kill the process mid-tool-call → reopen → `harness.resume()` finishes the task; resubmitting the same `requestId` does not duplicate work; a `deploy`-like non-safe tool is reported interrupted, never rerun.

### Phase 1 — Vibe loop (parallel conversations, one worktree each)
- `fork(entryId)` per task; each fork gets its own worktree + `cwd`, selected extensions/tools, and model (cheap model for triage/review, strong for implementation — the `triage` tool pattern).
- Subagents = conversations owned by the tool task (`ownership:{kind:"task"}`), foreground for answers, background anchor for persistent helpers.
- **Acceptance:** 3 forks run concurrently, none blocks another; aborting a parent aborts its owned subagents bottom-up; steering a busy conversation lands after the current tool round.

### Phase 2 — Antique-lite: intent review + landing
- Docs: `Plan`, `Review` (`defineDoc`, `fork:"asOf"`). Human approves plan/intent, not the diff.
- Approval hook: `beforeTool` + `api.memo("approval:push")` for push/deploy tools; reviewer conversation is read-only (`tools:{remove:[write,edit,bash]}`-style narrowing via `modelTools`/`configure`).
- Landing task (`defineTask`, phases `land → verify`): serializes `git push` to main, then background post-merge tests; on failure, forks a fix conversation with the failure as input. No merge queue, no global lock beyond the landing task.
- **Acceptance:** unapproved push is blocked and the block survives a restart (memo); a deliberately broken landing produces a fix conversation without human triage.

### Phase 3 — Superfans + long runs
- One background watcher conversation per surface (tests, CI, logs): tails output via a `replay:"safe"` tool, submits steers/follow-ups to main only on anomaly.
- Compaction settings (`reserveTokens`, `backgroundTokens`) + handoff tool for multi-hour sessions.
- Multiplayer: second client attaches with `viewState()`/`watch()`, joins late from current view, steers.
- **Acceptance:** watcher survives main-turn Esc; a >context session compacts in background without stopping work; late-joining client sees live tool output.

### Phase 4 — Guardrails (only when pain appears)
- `settings.restartLimit` parked-task surfacing (`task_parked` reports) + `retryTask`; idempotency keys on every external effect (`payment-${task.id}` pattern).
- Hot-swap an extension mid-run to fix a tool without restarting the harness.
- **Explicitly skipped until measured need:** new VCS/changeset store, blob caches, virtual FS, distributed storage (Postgres backend), global merge queue, per-directory IAM engine.

## 5. Risks
- Pi Durable is experimental (README + post agree): pin the version, isolate it behind your registry/extensions so an API break touches one layer.
- One process owns a storage at a time — multi-machine needs the Cloudflare Durable Object / remote-env path, not shared SQLite.
- Partial output is committed at ~100 ms intervals: a crash loses at most that window; non-idempotent tools must stay non-`replay:"safe"`.
