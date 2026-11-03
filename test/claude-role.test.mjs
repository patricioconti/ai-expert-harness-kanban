import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { claudeEnv, mapClaudeEvent, runClaudeRole } from '../harness/claude-role.mjs';

const task = { id: 'example', title: 'Example', objective: 'Works', criteria: ['Check works'], dependsOn: [] };
const role = (name) => ({ name, model: 'gpt-configured', thinking: 'max', developerInstructions: `Project ${name} instructions`, skillName: `feature-${name}`, skill: { path: '/tmp/SKILL.md', text: 'Project skill' } });
const runtime = { instructions: { text: 'Repo AGENTS.md' }, flow: { text: 'Project feature-flow' } };
const passing = { outcome: 'passing', summary: 'Checks passed', evidence: ['test passed'], files: ['test.js'], testing: 'Run the tests' };
const init = { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' };
const done = (fields) => ({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', ...fields });
// Answers each message it receives with the next batch, like a stream-json session.
function fakeSpawn(batches, seen = {}) {
  return (binary, args, options) => {
    Object.assign(seen, { binary, args, options, messages: [] });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('data', (chunk) => {
      seen.messages.push(JSON.parse(chunk.toString()).message.content);
      const batch = batches.shift() ?? [];
      setImmediate(() => { for (const event of batch) child.stdout.write(`${JSON.stringify(event)}\n`); });
    });
    return child;
  };
}
const flag = (args, name) => args[args.indexOf(name) + 1];
const listAfter = (args, name) => { const rest = args.slice(args.indexOf(name) + 1); return rest.slice(0, rest.findIndex((value) => value.startsWith('--'))); };

test('cada rol usa su modelo fijado, la sesión y herramientas acotadas', async () => {
  const seen = {};
  const result = await runClaudeRole({ task, role: role('implementer'), runtime, cwd: '/tmp', claudeBin: 'claude', env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://proxy', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/cfg' }, spawnImpl: fakeSpawn([[init, done({ structured_output: passing })]], seen) });
  assert.equal(result.outcome, 'passing');
  assert.deepEqual(result.evidence, passing.evidence);
  assert.equal(result.output, 'Done.');
  const args = seen.args.slice(2);
  assert.equal(seen.args[1], 'claude');
  assert.equal(flag(args, '--model'), 'opus');
  assert.equal(flag(args, '--effort'), 'max');
  assert.equal(flag(args, '--permission-mode'), 'dontAsk');
  assert.deepEqual(listAfter(args, '--allowedTools'), ['Edit', 'Write', 'Bash']);
  assert.ok(listAfter(args, '--disallowedTools').includes('Bash(git commit:*)'));
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--bare'));
  assert.match(flag(args, '--json-schema'), /"passing","block"/);
  assert.doesNotMatch(flag(args, '--append-system-prompt'), /Repo AGENTS\.md/);
  assert.match(flag(args, '--append-system-prompt'), /Project implementer instructions[^]*Project skill/);
  assert.deepEqual(seen.options.env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' });
  assert.match(seen.messages[0], /StructuredOutput/);
  assert.doesNotMatch(seen.messages[0], /<harness-result>/);
});

test('planner usa sonnet y el validator no puede editar archivos', async () => {
  const planner = {}; const validator = {};
  await runClaudeRole({ task, role: role('planner'), runtime, cwd: '/tmp', env: {}, spawnImpl: fakeSpawn([[init, done({ structured_output: { ...passing, outcome: 'ready' } })]], planner) });
  await runClaudeRole({ task, role: role('validator'), runtime, cwd: '/tmp', env: {}, spawnImpl: fakeSpawn([[init, done({ structured_output: { verdict: 'accept', summary: 'ok', evidence: ['rerun'], files: ['a.js'], testing: 'open it' } })]], validator) });
  assert.equal(flag(planner.args, '--model'), 'sonnet');
  assert.equal(flag(validator.args, '--model'), 'opus');
  assert.equal(flag(validator.args, '--tools'), 'Read,Glob,Grep,Bash');
  assert.deepEqual(listAfter(validator.args, '--allowedTools'), ['Bash']);
  assert.match(flag(validator.args, '--json-schema'), /"accept","revise","block"/);
});

test('se detiene si la sesión no es el login de la persona', async () => {
  await assert.rejects(runClaudeRole({ task, role: role('implementer'), runtime, cwd: '/tmp', env: {}, spawnImpl: fakeSpawn([[{ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }, done({ structured_output: passing })]]) }), /no está usando tu sesión[^]*ANTHROPIC_API_KEY/);
});

test('sin resultado estructurado recuerda el formato en la misma sesión', async () => {
  const seen = {}; const events = [];
  const result = await runClaudeRole({ task, role: role('implementer'), runtime, cwd: '/tmp', env: {}, emit: (event) => events.push(event), spawnImpl: fakeSpawn([[init, done({ result: 'Implemented it.' })], [done({ result: `<harness-result>${JSON.stringify(passing)}</harness-result>` })]], seen) });
  assert.equal(result.outcome, 'passing');
  assert.equal(seen.messages.length, 2);
  assert.match(seen.messages[1], /cannot be used/);
  assert.match(result.output, /^Implemented it\./);
  assert.ok(events.some((event) => event.level === 'warn' && /recuerda el formato \(1\/2\)/.test(event.message)));
});

test('un límite agotado pide pausar la cola y dice cuándo se renueva', async () => {
  const limit = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793649600, rateLimitType: 'five_hour' } };
  const error = await runClaudeRole({ task, role: role('implementer'), runtime, cwd: '/tmp', env: {}, spawnImpl: fakeSpawn([[init, limit, { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" }]]) }).catch((failure) => failure);
  assert.equal(error.pauseQueue, true);
  assert.match(error.message, /límite de tu suscripción[^]*se renueva/);
  const other = await runClaudeRole({ task, role: role('implementer'), runtime, cwd: '/tmp', env: {}, spawnImpl: fakeSpawn([[init, { type: 'result', subtype: 'error_max_turns', is_error: true }]]) }).catch((failure) => failure);
  assert.equal(other.pauseQueue, undefined);
  assert.match(other.message, /error_max_turns/);
});

test('los permisos de OpenCode no se ignoran en silencio', async () => {
  await assert.rejects(runClaudeRole({ task, role: { ...role('planner'), permissions: { edit: 'deny' } }, runtime, cwd: '/tmp', env: {}, spawnImpl: fakeSpawn([]) }), /permisos de \.opencode/);
});

test('la actividad describe herramientas, fallos y notas sin el resultado estructurado', () => {
  const names = new Map();
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: './gradlew   test' } }, { type: 'text', text: 'Running.\n<harness-result>{}</harness-result>' }, { type: 'tool_use', id: 't2', name: 'StructuredOutput', input: passing }] } };
  assert.deepEqual(mapClaudeEvent(tool, role('implementer'), names).map(({ kind, message }) => [kind, message]), [['tool', 'bash · ./gradlew test'], ['note', 'Running.']]);
  const failed = mapClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit 1' }] } }, role('implementer'), names);
  assert.equal(failed[0].level, 'error');
  assert.equal(failed[0].message, 'bash falló: exit 1');
  assert.match(mapClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'not JSON' }] }] } }, role('implementer'), names)[0].message, /^structuredoutput falló: not JSON/);
  assert.equal(mapClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, role('implementer')).length, 0);
  assert.match(mapClaudeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.91 } } } }, role('implementer'))[0].message, /91 %/);
});

test('el entorno conserva el login y descarta claves, proxies y la sesión padre', () => {
  assert.deepEqual(claudeEnv({ HOME: '/h', ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }), { HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
});
