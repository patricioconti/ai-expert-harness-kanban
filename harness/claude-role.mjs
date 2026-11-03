import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { roleStages } from './project-runtime.mjs';
import { pinnedClaude } from './claude-config.mjs';
import { buildPiPrompt, clip, describeTool, parseRoleResult, resultReminder, validateRoleResult } from './pi-role.mjs';

const supervisor = fileURLToPath(new URL('./pi-supervisor.mjs', import.meta.url));
const efforts = { off: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const editing = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'];
// dontAsk denies anything not listed here; read-only Bash is always allowed. The host still checks every role's files.
const roleTools = {
  planner: { tools: editing, allowed: ['Edit', 'Write'] },
  implementer: { tools: editing, allowed: ['Edit', 'Write', 'Bash'] },
  validator: { tools: ['Read', 'Glob', 'Grep', 'Bash'], allowed: ['Bash'] }
};
// Git belongs to the host. Deny rules win over allow rules; this is a second line behind the host's Git checks.
const hostGit = ['add', 'commit', 'push', 'checkout', 'switch', 'reset', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick', 'tag', 'config', 'worktree'].map((command) => `Bash(git ${command}:*)`);
const handoff = 'When done, return the structured handoff with the StructuredOutput tool, filled with actual results. Include all changed/reviewed file paths. If unable to proceed, return block and explain why. This structured handoff does not replace the project skill.';

export function claudeSchema(roleName) {
  const strings = { type: 'array', items: { type: 'string', minLength: 1 } };
  const common = { summary: { type: 'string', minLength: 1 }, evidence: strings, files: strings, testing: { type: 'string' } };
  if (roleName === 'validator') return { type: 'object', properties: { verdict: { type: 'string', enum: ['accept', 'revise', 'block'] }, ...common, repairBrief: { type: 'string' } }, required: ['verdict', 'summary', 'evidence', 'files', 'testing'] };
  return { type: 'object', properties: { outcome: { type: 'string', enum: [roleName === 'planner' ? 'ready' : 'passing', 'block'] }, ...common }, required: ['outcome', 'summary', 'evidence', 'files', 'testing'] };
}

export function claudeArgs({ role, system, model, effort }) {
  const { tools, allowed } = roleTools[role.name];
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--model', model, '--effort', effort, '--permission-mode', 'dontAsk', '--tools', tools.join(','),
    '--allowedTools', ...allowed, '--disallowedTools', ...hostGit,
    '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands',
    '--json-schema', JSON.stringify(claudeSchema(role.name)), '--append-system-prompt', system];
}

/** Only the person's login: no API key, gateway or cloud provider may leak in, nor the parent session's variables. */
export function claudeEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key) || !/^(ANTHROPIC|CLAUDE)/.test(key)));
}

const contentText = (content) => (typeof content === 'string' ? content : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
const userMessage = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
const percent = (value) => `${Math.round((value ?? 0) * 100)} %`;

export function mapClaudeEvent(event, role, toolNames = new Map()) {
  const base = { stage: roleStages[role.name], role: role.name, skill: role.skillName };
  const mapped = [];
  if (event.type === 'system' && event.subtype === 'init') mapped.push({ ...base, message: `Sesión ${role.name} iniciada · ${event.model}` });
  if (event.type === 'system' && event.subtype === 'compact_boundary') mapped.push({ ...base, message: 'Claude Code compacta el contexto de la sesión' });
  if (event.type === 'assistant') for (const part of event.message?.content ?? []) {
    if (part.type === 'tool_use') toolNames.set(part.id, part.name);
    if (part.type === 'tool_use' && part.name !== 'StructuredOutput') mapped.push({ ...base, kind: 'tool', message: describeTool(part.name.toLowerCase(), part.input) });
    const text = part.type === 'text' ? part.text.replace(/<harness-result>[^]*$/, '').trim() : '';
    if (text) mapped.push({ ...base, kind: 'note', message: clip(text, 240) });
  }
  if (event.type === 'user' && Array.isArray(event.message?.content)) for (const part of event.message.content) {
    if (part.type === 'tool_result' && part.is_error) mapped.push({ ...base, kind: 'tool', level: 'error', message: `${toolNames.get(part.tool_use_id)?.toLowerCase() ?? 'herramienta'} falló: ${clip(contentText(part.content))}` });
  }
  const limit = event.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (limit?.status === 'allowed_warning') mapped.push({ ...base, level: 'warn', message: `Te acercas al límite de tu suscripción (${limit.rateLimitType ?? 'ventana'} · ${percent(limit.unifiedWindows?.[limit.rateLimitType]?.utilization)})` });
  return mapped;
}

function limitError(limit) {
  const reset = limit?.resetsAt ? new Date(limit.resetsAt * 1000).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const error = new Error(`Se agotó el límite de tu suscripción de Claude Code${reset ? ` (se renueva ${reset})` : ''}. La cola queda en pausa; continúa desde este paso cuando se renueve`);
  error.pauseQueue = true;
  return error;
}

export async function runClaudeRole({ task, role, runtime, cwd, emit = () => {}, signal, repairBrief, humanFeedback, baseline, files, merge, device, claudeBin = 'claude', models = pinnedClaude.models, timeoutMs = 1_800_000, env = process.env, spawnImpl = spawn }) {
  if (signal?.aborted) throw new Error('Ejecución cancelada');
  if (role.permissions) throw new Error('El motor Claude Code todavía no aplica los permisos de .opencode/agents; usa Pi para este proyecto');
  const model = models[role.name];
  const effort = efforts[role.thinking] ?? 'high';
  emit({ stage: roleStages[role.name], role: role.name, skill: role.skillName, message: `Claude Code · ${model} · ${effort}` });
  // Claude Code loads the project's AGENTS.md from cwd itself, so only the flow, the role and its skill are appended.
  const system = [runtime.flow.text, role.developerInstructions, `Skill source: ${role.skill.path}\n${role.skill.text}`].join('\n\n');
  const prompt = buildPiPrompt({ task, role, repairBrief, humanFeedback, baseline, files, merge, device, handoff });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [supervisor, claudeBin, ...claudeArgs({ role, system, model, effort })], { cwd, env: claudeEnv(env), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let finished = false;
    let stderr = '';
    let report = '';
    let reminders = 0;
    let limit = null;
    const toolNames = new Map();
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      else child.kill();
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('Ejecución cancelada; la cola está pausada'));
    const timeout = setTimeout(() => finish(new Error(`Claude Code excedió ${Math.round(timeoutMs / 60_000)} minutos; se ha detenido`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    const onRecord = (event) => {
      if (finished) return;
      for (const mapped of mapClaudeEvent(event, role, toolNames)) emit(mapped);
      if (event.type === 'system' && event.subtype === 'init' && event.apiKeySource !== 'none') return finish(new Error(`Claude Code no está usando tu sesión (apiKeySource: ${event.apiKeySource}); este motor nunca usa API keys`));
      if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') limit = event.rate_limit_info;
      if (event.type !== 'result') return;
      const text = typeof event.result === 'string' ? event.result : '';
      if (event.is_error || event.subtype !== 'success') {
        if (limit || /usage limit|hit your limit|rate limit/i.test(text)) return finish(limitError(limit));
        return finish(new Error(`Claude Code no pudo completar el rol: ${clip(text || event.subtype)}`));
      }
      try {
        const value = event.structured_output ? validateRoleResult(event.structured_output, role.name) : parseRoleResult(text, role.name);
        finish(null, { ...value, output: report ? `${report}\n\n${text}` : text });
      } catch (error) {
        // A role that did the work but missed the handoff gets a reminder in the same session.
        if (reminders >= 2) return finish(error);
        reminders++;
        if (!report) report = text;
        emit({ stage: roleStages[role.name], role: role.name, skill: role.skillName, level: 'warn', message: `${role.name}: ${error.message}; el host le recuerda el formato (${reminders}/2)` });
        setImmediate(() => { if (!finished) child.stdin.write(userMessage(resultReminder(role.name, error.message))); });
      }
    };
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 8_000_000) return finish(new Error('Salida de Claude Code demasiado grande'));
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { finish(new Error('Claude Code devolvió salida stream-json inválida')); return; }
        try { onRecord(event); } catch (error) { finish(error); }
      }
    });
    child.on('close', (code) => { if (!finished) finish(new Error(stderr.trim() || `Claude Code terminó sin resultado (código ${code})`)); });
    child.stdin.write(userMessage(prompt));
  });
}
