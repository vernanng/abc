# AGENTS.md

Scion-style vibe-coding harness on Pi Durable + GitHub. `docs/SPEC.md` is binding — edit it before changing any requirement. `README.md` has the overview and current live state; don't duplicate them here.

## Commands

- `npm run build` — tsc to `dist/`. `npm run typecheck` — `npm test` is only an alias for this; there is no test framework.
- Focused checks (CI runs all): `npm run check:classify`, `npm run check:console`, `npm run check:proof-break`, `npm run console:build`.
- `npm run spike` / `npm run phase1` are **paid-model acceptance proofs**, not tests — never run them casually.

## Hard constraints (easy to break, expensive to undo)

- **Production is live on the VPS** (`abc-harness` systemd service). Never start the service on this Mac, and never run two harness processes against one storage — the Mac SQLite/journal is a stale pre-migration snapshot.
- `src/spike.ts` opens the same `./agent.sqlite` without the service lock — never run it while any service is up.
- Agent work lands only via GitHub PR + human approval. The model reviewer never approves; there is no console approve action; branch protection has **no required status checks** and approvals are not dismissed by pushes — don't add a CI gate or merge queue (SPEC §6.1).
- The classifier labels `.github/`, `secrets/`, `auth/`, `docs/SPEC.md`, `docs/PLAN.md`, `src/classify.ts` sensitive (owner intent approval). Note `.github/CODEOWNERS` currently only lists `.github/`, `docs/SPEC.md`, `docs/PLAN.md` — classifier-sensitive ≠ CODEOWNERS-covered until that file catches up.
- Exactly-once invariants: webhook delivery ID = `requestId`, delivery journal + `<!-- abc-agent:<delivery> -->` marker dedupe, `approvalBy` memo is first-write-wins. Don't weaken them.
- Secrets (`.env`, GitHub App `.pem`) are never committed, printed, or put in model-visible args. `.env.example` lists only env vars the code actually reads.
- Models go through OpenRouter only. No OpenCode or Pi CLI exists on the VPS — Pi is libraries inside the Node service.
- `docs/CONSOLE_PROOF.md`, `docs/PHASE_C_PROOF.md`, `docs/CONFLICT_PROOF.md` are landed proof artifacts, not docs — never edit them.

## Shipping

- Push to `main` → CI build → on green, CD auto-deploys to the VPS (`scripts/abc-deploy` + `scripts/deploy.sh` via a forced-command SSH key) and health-checks. Green CI also ships previously merged agent PRs — there is no manual deploy step unless CD itself is broken.
- Human-side doc/ops changes are committed directly to `main`; agent-authored code changes go through issues → PR → human intent approval.
- Expect `main` to advance under you (agent PRs land via GitHub): `git pull --rebase` before pushing, and preserve other authors' SPEC status-line text when resolving conflicts there.
