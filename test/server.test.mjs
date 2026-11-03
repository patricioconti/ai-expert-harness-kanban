import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { inspectProject } from '../harness/project-contract.mjs';
import { createHarnessServer } from '../server.mjs';
import { fixture, fakeExecutor, until } from './fixtures.mjs';

async function start(t, options = {}) {
  const statePath = join(fixture(), 'state.json');
  const harness = createHarnessServer({ statePath, piVersion: 'fixture', env: {}, ...options });
  harness.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => harness.server.once('listening', resolve));
  t.after(async () => { await harness.queue.close(); harness.server.closeAllConnections(); await new Promise((resolve) => harness.server.close(resolve)); });
  const base = `http://127.0.0.1:${harness.server.address().port}`;
  const post = (path, body = {}, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ...harness, base, post, statePath };
}

test('HTTP: selección, ejecución, evidencia y origen externo rechazado', async (t) => {
  const cwd = fixture();
  const { post, base, queue } = await start(t, { select: async () => inspectProject(cwd), executor: fakeExecutor() });
  assert.equal((await post('/api/projects/select', {}, { origin: 'https://outside.invalid' })).status, 403);
  const selected = await (await post('/api/projects/select')).json();
  assert.equal(selected.project.tasks.length, 1);
  assert.equal(selected.review.mode, 'local');
  assert.equal((await post('/api/queue', { taskIds: ['example'] })).status, 202);
  await until(() => queue.data.runs[0].status === 'review');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.runs[0].steps.length, 3);
  assert.ok(state.runs[0].commit);
  assert.equal(state.runs[0].branch, 'feat/example');
  assert.equal(state.runs[0].baseline, undefined);
  assert.equal((await post(`/api/runs/${state.runs[0].id}/merge`)).status, 200);
  assert.equal(queue.data.runs[0].status, 'done');
});

test('HTTP: content-type con charset, JSON inválido y rutas estáticas seguras', async (t) => {
  const { post, base } = await start(t);
  assert.equal((await post('/api/queue/pause', '{}', { 'content-type': 'application/json; charset=utf-8' })).status, 200);
  assert.equal((await post('/api/queue/pause', '{nope')).status, 400);
  assert.equal((await post('/api/queue/pause', '{}', { 'content-type': 'text/plain' })).status, 415);
  const first = await fetch(`${base}/api/state`);
  const tag = first.headers.get('etag');
  assert.ok(tag);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'if-none-match': tag } })).status, 304);
  assert.equal((await fetch(`${base}/`)).headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal((await fetch(`${base}/ui/board.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2Fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
});

test('HTTP: la API key se comprueba, no vuelve al navegador y solo se guarda si se pide', async (t) => {
  const checked = [];
  const verify = async (key) => { checked.push(key); if (key === 'sk-bad') throw new Error('DevExpert Inference ha rechazado la API key'); };
  const { post, base, statePath } = await start(t, { verify });
  assert.equal((await (await fetch(`${base}/api/state`)).json()).pi.credentials.configured, false);
  const rejected = await post('/api/credentials', { apiKey: 'sk-bad' });
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /rechazado/);
  const accepted = await post('/api/credentials', { apiKey: 'sk-good' });
  const text = await accepted.text();
  assert.doesNotMatch(text, /sk-good/);
  assert.deepEqual(JSON.parse(text).pi.credentials, { configured: true, source: 'ui' });
  assert.throws(() => statSync(join(statePath, '..', 'credentials.json')));
  await post('/api/credentials', { apiKey: 'sk-good', remember: true });
  const saved = join(statePath, '..', 'credentials.json');
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.match(readFileSync(saved, 'utf8'), /sk-good/);
  assert.deepEqual((await (await post('/api/credentials/clear')).json()).pi.credentials, { configured: false, source: null });
  assert.throws(() => statSync(saved));
  assert.deepEqual(checked, ['sk-bad', 'sk-good', 'sk-good']);
});

test('HTTP: con el motor claude cada rol usa su modelo y no se pide API key', async (t) => {
  const cwd = fixture();
  const { post, base, queue } = await start(t, { env: { HARNESS_ENGINE: 'claude' }, readAuth: () => ({ ok: true, plan: 'Team', problem: null }), select: async () => inspectProject(cwd), executor: fakeExecutor() });
  const { pi } = await (await fetch(`${base}/api/state`)).json();
  assert.equal(pi.engine, 'claude');
  assert.equal(pi.name, 'Claude Code');
  assert.equal(pi.credentials.kind, 'login');
  assert.equal(pi.credentials.configured, true);
  assert.deepEqual(pi.models, { planner: 'sonnet', implementer: 'opus', validator: 'opus' });
  const refused = await post('/api/credentials', { apiKey: 'sk-good' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /usa tu sesión/);
  await post('/api/projects/select');
  await post('/api/queue', { taskIds: ['example'] });
  await until(() => queue.data.runs[0].status === 'review');
  assert.deepEqual(queue.data.runs[0].steps.map(({ role, provider, model }) => [role, provider, model]), [['planner', 'claude-code', 'sonnet'], ['implementer', 'claude-code', 'opus'], ['validator', 'claude-code', 'opus']]);
});

test('HTTP: sin sesión de Claude Code no se encola y se puede volver a comprobar', async (t) => {
  const cwd = fixture();
  let answer = { ok: false, problem: 'No hay sesión en Claude Code. Inicia sesión con «claude auth login» y comprueba de nuevo' };
  const { post, base, queue } = await start(t, { env: { HARNESS_ENGINE: 'claude' }, readAuth: () => answer, select: async () => inspectProject(cwd), executor: fakeExecutor() });
  assert.equal((await (await fetch(`${base}/api/state`)).json()).pi.credentials.configured, false);
  await post('/api/projects/select');
  const refused = await post('/api/queue', { taskIds: ['example'] });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /claude auth login/);
  assert.equal(queue.data.runs.length, 0);
  answer = { ok: true, plan: 'Max', problem: null };
  const checked = await (await post('/api/login/refresh')).json();
  assert.equal(checked.pi.credentials.plan, 'Max');
  assert.equal((await post('/api/queue', { taskIds: ['example'] })).status, 202);
  await until(() => queue.data.runs[0].status === 'review');
});

test('HTTP: con Pi no existe la comprobación de sesión de Claude Code', async (t) => {
  const { post } = await start(t);
  assert.equal((await post('/api/login/refresh')).status, 409);
});

test('HARNESS_PROJECT abre el tablero con el proyecto ya seleccionado', async (t) => {
  const cwd = fixture();
  const { base } = await start(t, { env: { HARNESS_PROJECT: cwd } });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.projectPath, cwd);
  assert.equal(state.project.tasks.length, 1);
  assert.equal(state.review.mode, 'local');
  const statePath = join(fixture(), 'state.json');
  assert.throws(() => createHarnessServer({ statePath, piVersion: 'fixture', env: { HARNESS_PROJECT: '/no/such/project' } }), /HARNESS_PROJECT: /);
  // The failed start released its lock, so another server can take the same state.
  const retry = createHarnessServer({ statePath, piVersion: 'fixture', env: {} });
  await retry.queue.close();
  retry.server.close();
});

test('un servidor no puede sobrescribir el estado de otro servidor vivo', async (t) => {
  const { statePath } = await start(t);
  assert.throws(() => createHarnessServer({ statePath, piVersion: 'fixture' }), /Ya hay un servidor/);
});
