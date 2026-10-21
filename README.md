# abc

Scion-style vibe coding on [Pi Durable](https://github.com/earendil-works/pi) + GitHub: durable agents working on one repo in parallel, with human **intent review** before landing — no merge queue, no pre-merge CI gate, post-merge verification instead.

Full design: [docs/SPEC.md](docs/SPEC.md) (binding — edit it before changing a requirement) · Background/plan: [docs/PLAN.md](docs/PLAN.md) (historical) · Interactive demo: [index.html](index.html) (simulation only, served at `/?demo=1`)

## How it works

1. A repo collaborator files an issue, or comments `@agent …` on one.
2. The harness service verifies the GitHub App webhook, journals the delivery, and ACKs immediately; a sweeper drives the work in the background, so a crash mid-job loses nothing.
3. A worker agent implements the job in its own git worktree (branch `agent/<jobId>`); the service — never a model — commits and pushes the draft branch.
4. A deterministic risk classifier labels the final diff, and a read-only reviewer agent (different model family, never able to approve) posts an adversarial critique.
5. The service opens a PR with an **intent packet**: instruction, plan, classifier output, reviewer critique, test evidence.
6. A human approves the intent on the PR → squash-merge, immediately. There is no CI gate before landing; post-merge CI on `main` is the real gate. If `main` goes red, a fix job is forked automatically, and an auto-revert PR follows if it stays red past the window (30 min by default).

Effects are exactly-once or explicitly interrupted — never silently duplicated: webhook deliveries double as idempotency keys, and crashed work resumes from durable checkpoints instead of rerunning.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Durability spike: kill mid-tool → resume, `requestId` dedupe (`src/spike.ts`) | Proven 2026-10-21 |
| 1 | Parallel forks, one worktree each, role models, steering, abort cascade (`src/phase1.ts`) | Proven 2026-10-21 |
| B | GitHub App webhook service: signed delivery → triage comment, dedupe, crash recovery (`src/service.ts`, `src/github.ts`) | Proven 2026-10-22 |
| C | Worker job → draft branch → classifier + reviewer → intent-packet PR → merge on human approval | Proven 2026-10-22 (issue #6 → PR #7) |
| D | Post-merge self-healing: CI-failure fix jobs, auto-revert, conflict resolution, budget park | Proven 2026-10-22 |
| A | Live web console: stats dashboard, git graph, jobs table, instruct/steer/abort, open issue/PR links | Proven 2026-10-22; `index.html` survives only behind `/?demo=1` |
| — | Production hosting | **Live on a Linux VPS** (systemd `abc-harness`, Tailscale Funnel) since 2026-10-22; Mac host retired |

Proof details live in the status line of [docs/SPEC.md](docs/SPEC.md).

## Quick start

Requires Node.js (CI uses Node 22), an [OpenRouter](https://openrouter.ai) API key, and — for the service — a GitHub App (setup: [docs/GITHUB_APP.md](docs/GITHUB_APP.md)).

```bash
npm install
cp .env.example .env   # fill in OPENROUTER_API_KEY and model IDs
npm run spike -- submit  # build + Phase 0 durability spike
npm run spike -- resume  # reopen + resume; resubmit dedupes
npm run phase1           # build + Phase 1 parallel-fork acceptance run
```

These runs call paid models — `spike`/`phase1` are acceptance proofs, not tests. Bun 1.4+ can run the TypeScript sources directly after `npm install` (`npm run spike:bun`, `npm run phase1:bun`).

### Running the harness service

Production runs on the VPS (see Deployment below) — do not run a second copy against live state. For a local run, fill in the GitHub App settings in `.env` (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH` pointing at a `.pem` outside the repo, `WEBHOOK_SECRET`, `REPO`), then:

```bash
npm run service   # build service + console, node dist/service.js — listens on 127.0.0.1:8971 (PORT)
```

It serves `GET /health`, `POST /webhook`, the web console (`/`, `/auth/*`, `/api/state|transcript|instruct|steer|abort`, WebSocket `/ws`), and the simulation at `/?demo=1`. Point the App's webhook at `/webhook` (e.g. via a tunnel for local runs). Trigger work by opening an issue containing `@agent`, or commenting `@agent …` on an issue — only repo collaborators can instruct, everyone else gets one refusal comment. A plain new issue (no `@agent`) gets a triage comment only. There is no approve action in the console: landing approval is a GitHub PR review.

One warning that matters: one harness process owns the SQLite storage, and `spike` opens the same `./agent.sqlite` without the service's lock — never run it while the service is up.

## Deployment (live)

| | |
|---|---|
| Host | Linux VPS (Ubuntu 26.04, Node 22), `harness` user (sudo only for `systemctl restart abc-harness`, used by CD) |
| CD | Green `main` CI auto-deploys: Actions SSHs with a forced-command key → `scripts/abc-deploy` checks out the exact CI-passed commit → `scripts/deploy.sh` builds, restarts, health-checks. Green CI also finally ships merged changes (no manual redeploy) |
| Service | systemd `abc-harness` (enabled, `Restart=on-failure`), clone at `/home/harness/abc`, state at `/var/lib/harness/` (`agent.sqlite*`, `worktrees/`) |
| Public URL | https://piagentdev.tail2a29a7.ts.net (Tailscale Funnel → `127.0.0.1:8971`; console + webhook + OAuth callback all use this hostname) |
| Models | OpenRouter API only (worker `deepseek/deepseek-v4.1-flash`, reviewer `meta/muse-spark-1.3-contributor`, triage `z-ai/glm-5.3`); no OpenCode or Pi CLI on the box — Pi runs as libraries inside the service |
| Mac | Retired as host (service stopped, funnel off); its pre-migration state snapshot is the rollback fallback |

## Checks

There is no test framework. `npm test` is just an alias for the typecheck.

```bash
npm run typecheck      # tsc --noEmit
npm run check:classify # build + assert-based self-check for the risk classifier
npm run check:console  # build + self-check for the console git-graph layout
npm run check:proof-break # build + self-check that CI detects a broken main
```

CI (`.github/workflows/ci.yml`) runs build + all three checks + console build on push and PRs (advisory on PRs — landing is gated on human intent approval, not status checks; post-merge CI on `main` is the real gate).

## Layout

| Path | What |
|---|---|
| `src/service.ts` | The harness service: webhook ingress, job/review/CI drivers, landing, console API/WebSocket |
| `src/github.ts` | GitHub App client (installation token, signature verify, PR/issue/review API) |
| `src/classify.ts` | Deterministic risk classifier for the final diff (never approves) |
| `src/classify.check.ts` | Self-check for the classifier (`npm run check:classify`) |
| `src/console-data.ts` / `src/console.check.ts` | Console git-graph layout + self-check (`npm run check:console`) |
| `src/proof-break.check.ts` | Self-check that CI goes red on a broken main (`npm run check:proof-break`) |
| `src/spike.ts` | Phase 0 durability proof |
| `src/phase1.ts` | Phase 1 acceptance: forks, worktrees, steering, abort |
| `console/` | Vite + Preact web console (`npm run console:build` → `console/dist/`, served by the service) |
| `index.html` | Standalone simulation demo (served only at `/?demo=1`) |
| `docs/SPEC.md` | Binding spec (edit this before changing a requirement) |
| `docs/PLAN.md` | Historical source plan and Scion → Pi Durable mapping |
| `docs/GITHUB_APP.md` | GitHub App creation/install steps + live endpoint values |
| `.env.example` | Config template: only the env vars the code actually reads |

## Principles

1. Git stays; only the workflow is borrowed from Scion.
2. Work unit = durable conversation fork, not a long-lived branch.
3. Humans review the **intent** of every change before it lands; the model reviewer is adversarial only and never approves.
4. Effects are exactly-once (or explicitly interrupted) — never silently duplicated.
