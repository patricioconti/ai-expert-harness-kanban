#!/usr/bin/env node
// Claude Code de ensayo: habla stream-json como `claude -p` y hace un trabajo mínimo por rol, sin inferencia ni suscripción.
// HARNESS_ENGINE=claude CLAUDE_BIN=examples/mini-harness/fake-claude.mjs  ·  FAKE_CLAUDE_DELAY=ms entre pasos (por defecto 400)
// FAKE_CLAUDE_LOGIN=out|apikey: ensaya una sesión cerrada o una API key en vez de la suscripción.
// FAKE_CLAUDE_LIMIT=implementer (u otro rol): ese rol agota el límite de la suscripción a mitad de trabajo.
// FAKE_CLAUDE_CHEAT=validator: el validator, que no tiene Edit, «arregla» un archivo con Bash. El host lo para igual.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { jsonLike } from '../../harness/json-text.mjs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0 (Claude Code de ensayo)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  const login = process.env.FAKE_CLAUDE_LOGIN;
  console.log(JSON.stringify(login === 'out' ? { loggedIn: false } : { loggedIn: true, authMethod: login === 'apikey' ? 'apiKey' : 'claude.ai', apiProvider: 'firstParty', email: 'ensayo@example.invalid', orgName: 'Ensayo', subscriptionType: 'max' }));
  process.exit(0);
}
const flag = (name) => args[args.indexOf(name) + 1];
const tools = (flag('--tools') ?? '').split(',');
const model = { sonnet: 'claude-sonnet-ensayo', opus: 'claude-opus-ensayo' }[flag('--model')] ?? flag('--model');
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 400);
const sleep = () => new Promise((resolve) => setTimeout(resolve, delay));
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const changed = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => line.slice(3));
const window = (status) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: status === 'rejected' ? 1 : 0.2 } } } });
let calls = 0;

// Como Claude Code con --tools: una herramienta que el rol no tiene se rechaza y el trabajo sigue.
async function tool(name, input, action) {
  const id = `toolu_${++calls}`;
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  await sleep();
  const allowed = tools.includes(name);
  if (allowed) action?.();
  send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !allowed, content: allowed ? 'ok' : `No such tool available: ${name}` }] } });
}

async function play(message) {
  const role = message.match(/Your configured role: (\w+)/)?.[1];
  const id = message.match(/^Selected feature: ([\w-]+):/m)?.[1];
  const feedback = message.match(/(?:repair brief|requested changes[^:]*):\s*([^\n]+)/)?.[1];
  send({ type: 'system', subtype: 'init', apiKeySource: 'none', model, permissionMode: flag('--permission-mode'), tools });
  send(window('allowed'));
  await tool('Read', { file_path: 'AGENTS.md' });
  if (process.env.FAKE_CLAUDE_LIMIT === role) {
    send(window('rejected'));
    return send({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit (ensayo)" });
  }
  let result;
  if (role === 'planner') {
    const spec = `docs/specs/${id}.md`;
    await tool('Write', { file_path: spec }, () => write(spec, `# ${id}\n\nEscenario comprobable generado en ensayo.\n`));
    result = { outcome: 'ready', summary: `Spec de ${id} lista`, evidence: ['Spec con escenarios comprobables'], files: [spec], testing: `Lee ${spec}` };
  } else if (role === 'implementer') {
    const source = `src/${id}.js`;
    await tool('Write', { file_path: source }, () => write(source, `// ${id}: ${feedback ?? 'implementado en ensayo'}\nexport const ready = true;\n`));
    await tool('Bash', { command: 'node --test' });
    await tool('Edit', { file_path: 'feature_list.json' }, () => {
      const original = readFileSync('feature_list.json', 'utf8');
      const list = JSON.parse(original);
      Object.assign(list.find((item) => item.id === id), { status: 'passing', evidence: ['node --test: 1 passed (ensayo)'] });
      writeFileSync('feature_list.json', jsonLike(original, list));
    });
    await tool('Edit', { file_path: 'PROGRESS.md' }, () => appendFileSync('PROGRESS.md', `${existsSync('PROGRESS.md') ? '\n' : ''}- ${id}: passing (ensayo)\n`));
    result = { outcome: 'passing', summary: `${id} implementada`, evidence: ['node --test: 1 passed (ensayo)'], files: changed(), testing: 'node --test' };
  } else {
    await tool('Edit', { file_path: `src/${id}.js` });
    await tool('Bash', { command: 'node --test' });
    if (process.env.FAKE_CLAUDE_CHEAT === 'validator') await tool('Bash', { command: `echo '// Arreglo rápido del validator' >> src/${id}.js` }, () => appendFileSync(`src/${id}.js`, '// Arreglo rápido del validator\n'));
    result = { verdict: 'accept', summary: `${id} cumple su verificación`, evidence: ['Checks repetidos por el validator (ensayo)'], testing: `Abre src/${id}.js`, files: changed() };
  }
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Trabajo de ensayo terminado.' }, { type: 'tool_use', id: `toolu_${++calls}`, name: 'StructuredOutput', input: result }] } });
  send({ type: 'result', subtype: 'success', is_error: false, num_turns: calls, result: 'Hecho.', structured_output: result });
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const event = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (event.type === 'user') void play(event.message.content);
  }
});
