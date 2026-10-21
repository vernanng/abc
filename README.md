# abc

Scion-style vibe coding on [Pi Durable](https://github.com/earendil-works/pi) + GitHub: durable agents working on one repo in parallel, with human **intent review** before landing — no merge queue, no pre-merge CI gate, post-merge verification instead.

Full design: [docs/SPEC.md](docs/SPEC.md) (binding — edit it before changing a requirement) · Background/plan: [docs/PLAN.md](docs/PLAN.md) · Contributor/agent notes: [AGENTS.md](AGENTS.md) · Interactive demo: [index.html](index.html) (simulation only, open in a browser)

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
| D | Post-merge self-healing: CI-failure fix jobs, auto-revert, conflict resolution, budget park | Implemented in `src/service.ts`; see SPEC §8 for the acceptance run |
| A | Live web console | Not built — `index.html` is a simulation only |

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

Fill in the GitHub App settings in `.env` (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH` pointing at a `.pem` outside the repo, `WEBHOOK_SECRET`, `REPO`), then:

```bash
npm run service   # build + node dist/service.js — listens on 127.0.0.1:8971 (PORT)
```

It serves `GET /health` and `POST /webhook` only; point the App's webhook at `/webhook` (e.g. via a tunnel for local runs). Trigger work by opening an issue containing `@agent`, or commenting `@agent …` on an issue — only repo collaborators can instruct, everyone else gets one refusal comment. A plain new issue (no `@agent`) gets a triage comment only.

One warning that matters: one harness process owns the SQLite storage, and `spike` opens the same `./agent.sqlite` without the service's lock — never run it while the service is up.

## Checks

There is no test framework. `npm test` is just an alias for the typecheck.

```bash
npm run typecheck      # tsc --noEmit
npm run check:classify # build + assert-based self-check for the risk classifier
```

CI runs the same two steps on push and PRs (advisory on PRs — landing is gated on human intent approval, not status checks).

## Layout

| Path | What |
|---|---|
| `src/service.ts` | The harness service: webhook ingress, job/review/CI drivers, landing |
| `src/github.ts` | GitHub App client (installation token, signature verify, PR/issue/review API) |
| `src/classify.ts` | Deterministic risk classifier for the final diff (never approves) |
| `src/classify.check.ts` | Self-check for the classifier (`npm run check:classify`) |
| `src/spike.ts` | Phase 0 durability proof |
| `src/phase1.ts` | Phase 1 acceptance: forks, worktrees, steering, abort |
| `index.html` | Standalone simulation demo |
| `docs/SPEC.md` | Binding spec (edit this before changing a requirement) |
| `docs/PLAN.md` | Source plan and Scion → Pi Durable mapping |
| `docs/GITHUB_APP.md` | GitHub App creation/install steps |
| `.env.example` | Config template: models, budgets, GitHub App, paths |
| `AGENTS.md` | Hard-won operational gotchas for contributors and agents |

## Principles

1. Git stays; only the workflow is borrowed from Scion.
2. Work unit = durable conversation fork, not a long-lived branch.
3. Humans review the **intent** of every change before it lands; the model reviewer is adversarial only and never approves.
4. Effects are exactly-once (or explicitly interrupted) — never silently duplicated.
