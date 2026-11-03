import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FeatureQueue } from '../harness/queue.mjs';
import { StateStore } from '../harness/state-store.mjs';
import { inspectProject } from '../harness/project-contract.mjs';
import { runClaudeRole } from '../harness/claude-role.mjs';
import { readClaudeAuth } from '../harness/claude-auth.mjs';
import { engineFor } from '../harness/engine.mjs';
import { fixture, feature, until } from './fixtures.mjs';

const fakeClaude = fileURLToPath(new URL('../examples/mini-harness/fake-claude.mjs', import.meta.url));
const options = engineFor({ HARNESS_ENGINE: 'claude', CLAUDE_BIN: fakeClaude }).options;

async function rehearse(t, extra = {}) {
  const queue = new FeatureQueue({ store: new StateStore(join(fixture(), 'state.json')), executor: runClaudeRole, piVersion: 'fake', piOptions: { ...options, env: { ...process.env, FAKE_CLAUDE_DELAY: '0', ...extra } } });
  t.after(() => queue.close());
  queue.select(inspectProject(fixture([feature('search'), feature('filters')])));
  queue.enqueue(['search', 'filters']);
  await until(() => queue.data.runs.some((run) => ['review', 'blocked'].includes(run.status)), 20_000);
  await until(() => !queue.data.runs.some((run) => run.status === 'running'), 20_000);
  return { queue, run: queue.data.runs.find((item) => item.taskId === 'search') };
}

test('el Kanban completa una feature con el adaptador Claude real contra el Claude Code de ensayo', async (t) => {
  const { run } = await rehearse(t);
  assert.equal(run.error ?? null, null);
  assert.equal(run.status, 'review');
  assert.deepEqual(run.steps.map(({ role, provider, model }) => [role, provider, model]), [['planner', 'claude-code', 'sonnet'], ['implementer', 'claude-code', 'opus'], ['validator', 'claude-code', 'opus']]);
  const messages = run.events.map((event) => event.message);
  assert.ok(messages.includes('write · src/search.js'));
  assert.ok(messages.includes('Sesión validator iniciada · claude-opus-ensayo'));
  // The validator has no Edit tool: the attempt is refused and the work goes on.
  assert.ok(messages.some((message) => /^edit falló: No such tool/.test(message)));
});

test('ensayo: un límite agotado bloquea la feature con su renovación y pausa la cola', async (t) => {
  const { queue, run } = await rehearse(t, { FAKE_CLAUDE_LIMIT: 'implementer' });
  assert.equal(run.status, 'blocked');
  assert.match(run.error, /límite de tu suscripción[^]*se renueva/);
  assert.equal(run.nextRole, 'implementer');
  assert.equal(queue.data.paused, true);
});

test('ensayo: el host para al validator que escribe con Bash', async (t) => {
  const { run } = await rehearse(t, { FAKE_CLAUDE_CHEAT: 'validator' });
  assert.equal(run.status, 'blocked');
  assert.match(run.error, /Validator modificó archivos/);
});

test('ensayo: la sesión de prueba se lee como la de verdad', () => {
  assert.equal(readClaudeAuth({ claudeBin: fakeClaude, env: process.env }).plan, 'Max');
  assert.match(readClaudeAuth({ claudeBin: fakeClaude, env: { ...process.env, FAKE_CLAUDE_LOGIN: 'out' } }).problem, /claude auth login/);
  assert.match(readClaudeAuth({ claudeBin: fakeClaude, env: { ...process.env, FAKE_CLAUDE_LOGIN: 'apikey' } }).problem, /solo funciona con tu suscripción/);
});
