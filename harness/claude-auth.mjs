import { spawnSync } from 'node:child_process';
import { claudeEnv } from './claude-role.mjs';

const plans = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

/** What `claude auth status` reports, read with the same filtered environment the roles get. */
export function readClaudeAuth({ claudeBin = 'claude', env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const run = spawnSyncImpl(claudeBin, ['auth', 'status', '--json'], { env: claudeEnv(env), encoding: 'utf8', timeout: 10_000 });
  if (run.error) return { ok: false, problem: run.error.code === 'ENOENT' ? 'Claude Code no está instalado' : `No se pudo consultar la sesión de Claude Code: ${run.error.message}` };
  let status;
  try { status = JSON.parse(run.stdout); } catch { return { ok: false, problem: `Claude Code no informó su sesión${run.stderr ? `: ${run.stderr.trim().slice(0, 160)}` : ''}` }; }
  const details = { plan: plans[status.subscriptionType] ?? status.subscriptionType ?? null, email: status.email ?? null, org: status.orgName ?? null };
  if (!status.loggedIn) return { ok: false, ...details, problem: 'No hay sesión en Claude Code. Inicia sesión con «claude auth login» y comprueba de nuevo' };
  // Only a claude.ai login draws on the subscription; anything else would bill an API account or a cloud provider.
  if (status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') return { ok: false, ...details, problem: `Claude Code usa ${status.authMethod ?? 'otro método'} (${status.apiProvider ?? 'proveedor desconocido'}); este motor solo funciona con tu suscripción de claude.ai` };
  return { ok: true, ...details, problem: null };
}

/** Same surface as Credentials, so the queue treats both engines alike; there is no secret to hold. */
export class ClaudeLogin {
  constructor({ claudeBin, env = process.env, read = readClaudeAuth }) {
    Object.assign(this, { claudeBin, baseEnv: env, read });
    this.refresh();
  }
  refresh() {
    this.state = { ...this.read({ claudeBin: this.claudeBin, env: this.baseEnv }), checkedAt: new Date().toISOString() };
    return this.state;
  }
  status() { return { kind: 'login', configured: this.state.ok, source: 'login', ...this.state }; }
  env() { return this.baseEnv; }
}
