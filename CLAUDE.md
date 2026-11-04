# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local Kanban UI (`server.mjs` + `public/`) that drives the AI Expert `feature-flow` on a *target* Git project: for each pending feature in that project's `feature_list.json` it runs three independent agent roles — planner → implementer → validator — each in a fresh session of the selected engine (Pi RPC by default, or `claude -p` on the person's Claude Code subscription) inside a per-feature worktree, then commits and hands the branch to human review (GitHub PR via `gh`, or a local branch). README.md (Spanish) is the authoritative product description.

Node ≥ 22, plain ES modules, **no npm dependencies and no build step**. The frontend in `public/` is served as-is.

## Commands

```sh
pnpm dev                 # server on http://localhost:4173 (needs Pi installed + DevExpert API key)
pnpm dev:ensayo          # rehearsal: fake Pi (examples/mini-harness/fake-pi.mjs), local review only, state in .harness-data/ensayo/
HARNESS_ENGINE=claude pnpm dev   # roles on the person's Claude Code login (OAuth), never an API key
pnpm dev:ensayo:claude   # rehearsal of the claude engine with examples/mini-harness/fake-claude.mjs, state in .harness-data/ensayo-claude/
pnpm check               # node --check on every JS file + node --test test/*.test.mjs (disposable git fixtures, no network)
pnpm check:pi            # Pi RPC protocol check, no inference
HARNESS_SOURCE_PROJECT=/path DEVEXPERT_API_KEY=… pnpm check:pi:e2e   # opt-in real run, consumes inference

node --test test/queue.test.mjs                          # single test file
node --test --test-name-pattern="some name" test/*.test.mjs  # single test by name
```

Env vars: `HARNESS_ENGINE=pi|claude` (default `pi`; anything else fails at start), `HARNESS_REVIEW=local|github`, `HARNESS_PARALLEL` (default 3, clamped 1–8), `HARNESS_ANDROID_DEVICES` (comma-separated serials; each running feature leases a free one that `adb devices` lists as ready at start, as `ANDROID_SERIAL` and the prompt names it, `none` when all are held; unset leaves `ANDROID_SERIAL` alone), `HARNESS_STATE_PATH`, `HARNESS_PROJECT` (preselects that project at start; an invalid one stops the server), `PI_BIN`, `PI_TIMEOUT_MS`, `DEVEXPERT_API_KEY`, `CLAUDE_BIN`, `CLAUDE_TIMEOUT_MS`. With Pi the provider/model is pinned in `harness/pi-config.mjs` (DevExpert Inference → `chat`); with claude the per-role models are pinned in `harness/claude-config.mjs` (planner sonnet, implementer and validator opus). Neither can be overridden by `PI_MODEL`/`PI_PROVIDER`/`ANTHROPIC_MODEL` or ambient credentials — keep it that way.

## Architecture

- `server.mjs` — loopback-only HTTP server (rejects non-localhost hosts and cross-origin mutations). Exposes a JSON API over a single `FeatureQueue` and serves flat files from `public/`. Takes a lock on the state path (`server-lock.mjs`) so only one server owns a state file.
- `harness/queue.mjs` (`FeatureQueue`) — the product layer: dependency-ordered queue, parallel execution up to `maxParallel`, one `feat/<id>` branch + worktree per feature under `.harness-data/worktrees/`, run lifecycle/statuses, review creation and PR polling, branch sync after integration. A dependency only counts once it is **integrated** into the base (`settled()`), not merely accepted.
- `harness/feature-flow.mjs` (`executeFeature`) — the deterministic per-feature loop: run each role, verify with Git that the role stayed within its rules (inventory/contract unchanged, files scoped, validator wrote nothing), repair loop (max 3), then `finalize()` writes `accepted` + evidence atomically and makes a scoped commit. It is written to be crash-resumable: values are persisted before writes, and finalize recovers the window between commit and recording the hash. Preserve this ordering when editing.
- `harness/engine.mjs` (`engineFor`) — picks the engine from `HARNESS_ENGINE`: its options, executor and binary. `server.mjs` uses it to detect the binary and choose credentials (DevExpert key for Pi, `ClaudeLogin` for claude). The snapshot key stays `pi` for both engines, with `engine`, `name` and `models` added.
- `harness/pi-role.mjs` — spawns Pi in RPC mode for one role, builds the prompt (`buildPiPrompt`, shared by both engines), and parses the mandatory `<harness-result>{…}</harness-result>` JSON handoff (`resultSchema`). `opencode-permissions.mjs` is a Pi extension enforcing OpenCode `permission` rules per tool call; `devexpert-provider.mjs` is the Pi provider extension.
- `harness/claude-role.mjs` (`runClaudeRole`) — same executor contract over `claude -p --input-format/--output-format stream-json`: `dontAsk` with per-role `--tools`/`--allowedTools`, git write commands denied, handoff through `--json-schema` (`structured_output`) with the `<harness-result>` fallback and reminders. `claudeEnv` drops every `ANTHROPIC_*`/`CLAUDE*` variable except `CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_OAUTH_TOKEN`, and the init event must report `apiKeySource: none`. Never add `--bare`: it only accepts API keys. An exhausted limit throws with `pauseQueue`, which `queue.fail` turns into a paused queue. `claude-auth.mjs` reads `claude auth status --json` with the same filtered env; `ClaudeLogin` mirrors the `Credentials` surface and adds `refresh()`, which `enqueue` calls.
- `harness/reap.mjs` — after every role (success, error or cancel) `executeFeature` closes processes started during that role whose cwd is inside the worktree, before the file snapshot. Background jobs and apps launched via the Gradle daemon escape the role's process group, so they are found by cwd and start time.
- Scratch dirs — `executeFeature` gives every role of every run `/tmp/harness/<run8>-<role>` as `TMPDIR`/`TMP`/`TEMP` (`scratch` reaches the executor; Claude gets `--add-dir`; the prompt says to use it instead of `/tmp`) and deletes it after the role. Keep the path short: macOS caps Unix socket paths near 104 bytes.
- `harness/project-contract.mjs` — strict validation of the target project's `feature_list.json` (flat array, exactly nine fields, safe ids, no missing deps or cycles). `project-runtime.mjs` loads role definitions from `.opencode/agents/*.md` (preferred) or `.codex/config.toml` + `.codex/agents/*.toml`, plus `.agents/skills/*`, and fingerprints them; a fingerprint change mid-run is an error.
- `harness/state-store.mjs` — atomic JSON state at `.harness-data/state.json` (outside the target repo). On restart, active runs become `interrupted` and the queue is paused; nothing resumes without explicit user action.
- `harness/review.mjs` / `branch-sync.mjs` — GitHub (`gh`) vs local review adapters; auto-resolve conflicts only in `feature_list.json` (merge by id) and `PROGRESS.md` (union). Other conflicts go through the `resolve` action: `startMerge` leaves markers as plain working-tree changes, the implementer resolves them, the validator reviews, and `scopedMergeCommit` makes the two-parent commit.
- `public/` — vanilla ES-module UI. `app.js` polls state every ~1.2 s with ETag; `ui/model.js` is the pure view model (tested in `test/app.test.mjs`); `ui/board.js`/`detail.js` redraw by region.
- `examples/mini-harness/` — a didactic single-file version (`harness.mjs`: `next` table, `rules` table, `runFeature` loop) used for teaching; `fake-pi.mjs` there is also the rehearsal Pi used by `pnpm dev:ensayo` and tests. Its rules mirror `harness/feature-flow.mjs`.

Only the planner may change the spec. If the implementer touches it, `executeFeature` keeps its files in `ownedFiles`, makes the planner the next role and drops `specHash`, so continuing re-plans; after the planner, a feature that is already `passing` goes straight to the validator.

Feature status lifecycle in the target project: `not_started` → `in_progress` → `passing` (set by implementer) → `accepted` (set only by the host). `blocked` for blocks. Roles must never commit, stage, switch branches, push, or set `accepted` — the host owns Git.

## Testing

Tests build throwaway Git repos with `test/fixtures.mjs` (`fixture()`, `feature()`, supporting both `codex` and `opencode` layouts) and inject fake executors / fake `gh`; they must not need network, a provider, or real GitHub. Claude-engine tests use a fake `spawnImpl`, an injected `readAuth`, or `fake-claude.mjs`; never the real `claude` CLI. The reap step scans `lsof` after each role, so the suite takes about twice as long as before.

## Conventions

- User-facing strings and error messages are in Spanish; identifiers, code comments and CLI flags are in English.
- Code is dense: short helpers, few comments, comments only for non-obvious invariants (crash windows, why a path is absolute, etc.).
- Commits use conventional prefixes (`feat:`, `fix:`, `refactor:`) with lowercase, plain-language subjects.
