# abc

Scion-style vibe coding on [Pi Durable](https://github.com/earendil-works/pi) + GitHub: durable agents working on one repo in parallel, with human **intent review** before landing — no merge queue, no pre-merge CI gate, post-merge verification instead.

Full design: [docs/SPEC.md](docs/SPEC.md) · Background/plan: [docs/PLAN.md](docs/PLAN.md) · Interactive demo: [index.html](index.html) (simulation only, open in a browser)

## Status

- **Phase 0 — proven** (2026-10-21): `src/spike.ts` — kill mid-tool → `resume()` continues, same `requestId` dedupes, usage committed. See SPEC §1.
- **Phase 1 — in progress**: `src/phase1.ts` — parallel forks (one worktree each), role models, steering, abort cascade, single-owner lock guard.
- Phases A–D (live site, harness service, landings) are specified but not built yet.

## Quick start

Requires Node.js and an [OpenRouter](https://openrouter.ai) API key.

```bash
npm install
cp .env.example .env   # fill in OPENROUTER_API_KEY and model IDs
npm run spike -- submit  # build + Phase 0 durability spike
npm run spike -- resume  # reopen + resume; resubmit dedupes
npm run phase1           # build + Phase 1 parallel-fork acceptance run
```

Bun 1.4+ can run the TypeScript sources directly after `npm install`:

```bash
npm run spike:bun -- open-only
npm run phase1:bun
```

## Layout

| Path | What |
|---|---|
| `src/spike.ts` | Phase 0 durability proof |
| `src/phase1.ts` | Phase 1 acceptance: forks, worktrees, steering, abort |
| `index.html` | Standalone simulation demo |
| `docs/SPEC.md` | Binding spec (edit this before changing a requirement) |
| `docs/PLAN.md` | Source plan and Scion → Pi Durable mapping |
| `.env.example` | All config: models, budgets, GitHub/VPS/Cloudflare (later phases) |

## Principles

1. Git stays; only the workflow is borrowed from Scion.
2. Work unit = durable conversation fork, not a long-lived branch.
3. Humans review the **intent** of every change before it lands; the model reviewer is adversarial only and never approves.
4. Effects are exactly-once (or explicitly interrupted) — never silently duplicated.
