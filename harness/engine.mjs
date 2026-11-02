import { piOptions } from './pi-config.mjs';
import { claudeOptions } from './claude-config.mjs';
import { runPiRole } from './pi-role.mjs';
import { runClaudeRole } from './claude-role.mjs';

// Pi stays the default because the course flow pins DevExpert; `claude` runs on the person's subscription.
const engines = {
  pi: { name: 'Pi', options: piOptions, executor: runPiRole, bin: (options) => options.piBin },
  claude: { name: 'Claude Code', options: claudeOptions, executor: runClaudeRole, bin: (options) => options.claudeBin }
};

export function engineFor(env = process.env) {
  const id = env.HARNESS_ENGINE ?? 'pi';
  if (!Object.hasOwn(engines, id)) throw new Error(`HARNESS_ENGINE debe ser pi o claude, no «${id}»`);
  const engine = engines[id];
  return { ...engine, id, options: { engine: id, engineName: engine.name, ...engine.options(env) } };
}
