import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeLogin, readClaudeAuth } from '../harness/claude-auth.mjs';

const status = (fields) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.invalid', orgName: 'Example Org', subscriptionType: 'team', ...fields });
const fakeSpawnSync = (stdout, seen = {}) => (binary, args, options) => { Object.assign(seen, { binary, args, options }); return { status: 0, stdout, stderr: '' }; };

test('una sesión de claude.ai vale y se lee con el entorno filtrado de los roles', () => {
  const seen = {};
  const login = readClaudeAuth({ claudeBin: '/opt/claude', env: { HOME: '/h', ANTHROPIC_API_KEY: 'sk-x', CLAUDECODE: '1' }, spawnSyncImpl: fakeSpawnSync(status({}), seen) });
  assert.deepEqual(login, { ok: true, plan: 'Team', email: 'person@example.invalid', org: 'Example Org', problem: null });
  assert.equal(seen.binary, '/opt/claude');
  assert.deepEqual(seen.args, ['auth', 'status', '--json']);
  assert.deepEqual(seen.options.env, { HOME: '/h' });
});

test('sin sesión, con API key o con otro proveedor no se puede ejecutar', () => {
  assert.match(readClaudeAuth({ env: {}, spawnSyncImpl: fakeSpawnSync(JSON.stringify({ loggedIn: false })) }).problem, /claude auth login/);
  for (const fields of [{ authMethod: 'apiKey' }, { apiProvider: 'bedrock' }]) {
    const login = readClaudeAuth({ env: {}, spawnSyncImpl: fakeSpawnSync(status(fields)) });
    assert.equal(login.ok, false);
    assert.match(login.problem, /solo funciona con tu suscripción/);
  }
});

test('un CLI ausente o una respuesta ilegible se explican', () => {
  const missing = readClaudeAuth({ env: {}, spawnSyncImpl: () => ({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }) });
  assert.deepEqual(missing, { ok: false, problem: 'Claude Code no está instalado' });
  assert.match(readClaudeAuth({ env: {}, spawnSyncImpl: () => ({ status: 1, stdout: 'oops', stderr: 'boom' }) }).problem, /no informó su sesión: boom/);
});

test('ClaudeLogin vuelve a comprobar bajo demanda y expone el formato de credenciales', () => {
  const answers = [{ ok: true, plan: 'Max', problem: null }, { ok: false, problem: 'No hay sesión' }];
  const login = new ClaudeLogin({ claudeBin: 'claude', env: { HOME: '/h' }, read: () => answers.shift() });
  assert.equal(login.status().configured, true);
  assert.equal(login.status().kind, 'login');
  assert.equal(login.refresh().ok, false);
  assert.equal(login.status().problem, 'No hay sesión');
  assert.deepEqual(login.env(), { HOME: '/h' });
});
