import { piBinary } from './pi-config.mjs';

// Explicit product choice: the person's Claude Code login (OAuth), never an API key, with a model per role.
export const pinnedClaude = Object.freeze({ provider: 'claude-code', name: 'Claude Code', models: Object.freeze({ planner: 'sonnet', implementer: 'opus', validator: 'opus' }) });

export function claudeOptions(env = process.env) {
  return { claudeBin: piBinary(env.CLAUDE_BIN ?? 'claude'), provider: pinnedClaude.provider, models: pinnedClaude.models, timeoutMs: Number(env.CLAUDE_TIMEOUT_MS ?? 1_800_000) };
}
