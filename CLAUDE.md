# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local Kanban UI (`server.mjs` + `public/`) that drives the AI Expert `feature-flow` on a *target* Git project: for each pending feature in that project's `feature_list.json` it runs three independent Pi agent roles — planner → implementer → validator — each in a fresh Pi RPC session inside a per-feature worktree, then commits and hands the branch to human review (GitHub PR via `gh`, or a local branch). README.md (Spanish) is the authoritative product description.

Node ≥ 22, plain ES modules, **no npm dependencies and no build step**. The frontend in `public/` is served as-is.

## Commands

```sh
pnpm dev                 # server on http://localhost:4173 (needs Pi installed + DevExpert API key)
pnpm dev:ensayo          # rehearsal: fake Pi (examples/mini-harness/fake-pi.mjs), local review only, state in .harness-data/ensayo/
pnpm check               # node --check on every JS file + node --test test/*.test.mjs (disposable git fixtures, no network)
pnpm check:pi            # Pi RPC protocol check, no inference
HARNESS_SOURCE_PROJECT=/path DEVEXPERT_API_KEY=… pnpm check:pi:e2e   # opt-in real run, consumes inference

node --test test/queue.test.mjs                          # single test file
node --test --test-name-pattern="some name" test/*.test.mjs  # single test by name
```

Env vars: `HARNESS_REVIEW=local|github`, `HARNESS_PARALLEL` (default 3, clamped 1–8), `HARNESS_STATE_PATH`, `PI_BIN`, `PI_TIMEOUT_MS`, `DEVEXPERT_API_KEY`. The provider/model is pinned in `harness/pi-config.mjs` (DevExpert Inference → `chat`) and deliberately cannot be overridden by `PI_MODEL`/`PI_PROVIDER` or ambient credentials — keep it that way.

## Architecture

- `server.mjs` — loopback-only HTTP server (rejects non-localhost hosts and cross-origin mutations). Exposes a JSON API over a single `FeatureQueue` and serves flat files from `public/`. Takes a lock on the state path (`server-lock.mjs`) so only one server owns a state file.
- `harness/queue.mjs` (`FeatureQueue`) — the product layer: dependency-ordered queue, parallel execution up to `maxParallel`, one `feat/<id>` branch + worktree per feature under `.harness-data/worktrees/`, run lifecycle/statuses, review creation and PR polling, branch sync after integration. A dependency only counts once it is **integrated** into the base (`settled()`), not merely accepted.
- `harness/feature-flow.mjs` (`executeFeature`) — the deterministic per-feature loop: run each role, verify with Git that the role stayed within its rules (inventory/contract unchanged, files scoped, validator wrote nothing), repair loop (max 3), then `finalize()` writes `accepted` + evidence atomically and makes a scoped commit. It is written to be crash-resumable: values are persisted before writes, and finalize recovers the window between commit and recording the hash. Preserve this ordering when editing.
- `harness/pi-role.mjs` — spawns Pi in RPC mode for one role, builds the prompt, and parses the mandatory `<harness-result>{…}</harness-result>` JSON handoff (`resultSchema`). `opencode-permissions.mjs` is a Pi extension enforcing OpenCode `permission` rules per tool call; `devexpert-provider.mjs` is the Pi provider extension.
- `harness/project-contract.mjs` — strict validation of the target project's `feature_list.json` (flat array, exactly nine fields, safe ids, no missing deps or cycles). `project-runtime.mjs` loads role definitions from `.opencode/agents/*.md` (preferred) or `.codex/config.toml` + `.codex/agents/*.toml`, plus `.agents/skills/*`, and fingerprints them; a fingerprint change mid-run is an error.
- `harness/state-store.mjs` — atomic JSON state at `.harness-data/state.json` (outside the target repo). On restart, active runs become `interrupted` and the queue is paused; nothing resumes without explicit user action.
- `harness/review.mjs` / `branch-sync.mjs` — GitHub (`gh`) vs local review adapters; auto-resolve conflicts only in `feature_list.json` (merge by id) and `PROGRESS.md` (union).
- `public/` — vanilla ES-module UI. `app.js` polls state every ~1.2 s with ETag; `ui/model.js` is the pure view model (tested in `test/app.test.mjs`); `ui/board.js`/`detail.js` redraw by region.
- `examples/mini-harness/` — a didactic single-file version (`harness.mjs`: `next` table, `rules` table, `runFeature` loop) used for teaching; `fake-pi.mjs` there is also the rehearsal Pi used by `pnpm dev:ensayo` and tests. Its rules mirror `harness/feature-flow.mjs`.

Feature status lifecycle in the target project: `not_started` → `in_progress` → `passing` (set by implementer) → `accepted` (set only by the host). `blocked` for blocks. Roles must never commit, stage, switch branches, push, or set `accepted` — the host owns Git.

## Testing

Tests build throwaway Git repos with `test/fixtures.mjs` (`fixture()`, `feature()`, supporting both `codex` and `opencode` layouts) and inject fake executors / fake `gh`; they must not need network, a provider, or real GitHub.

## Conventions

- User-facing strings and error messages are in Spanish; identifiers, code comments and CLI flags are in English.
- Code is dense: short helpers, few comments, comments only for non-obvious invariants (crash windows, why a path is absolute, etc.).
- Commits use conventional prefixes (`feat:`, `fix:`, `refactor:`) with lowercase, plain-language subjects.
