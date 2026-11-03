import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

// `[[dd-]hh:]mm:ss`, as BSD and GNU ps print etime.
export function elapsedSeconds(etime) {
  const [days, clock] = etime.includes('-') ? etime.split('-') : [0, etime];
  return Number(days) * 86_400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const output = (run, args) => { try { return run(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }); } catch (error) { return error.stdout ?? ''; } };

/**
 * Processes a role left running in its worktree. A dev server sent to the background or an app launched
 * through the Gradle daemon lives outside the role's process group, so they are found by working directory.
 * Only those started after `since` count: a shell or editor the person already had open there is left alone.
 */
export function leftovers(root, since, { run = execFileSync, now = Date.now() } = {}) {
  let real;
  try { real = realpathSync(root); } catch { return []; }
  const candidates = [];
  let pid = null;
  for (const line of output(run, ['lsof', '-d', 'cwd', '-Fpcn']).split('\n')) {
    if (line[0] === 'p') pid = { pid: Number(line.slice(1)) };
    if (line[0] === 'c' && pid) pid.command = line.slice(1);
    if (line[0] === 'n' && pid && (line.slice(1) === real || line.slice(1).startsWith(real + sep))) candidates.push(pid);
  }
  const mine = candidates.filter((item) => item.pid !== process.pid);
  if (!mine.length) return [];
  const ages = new Map(output(run, ['ps', '-o', 'pid=,etime=', '-p', mine.map((item) => item.pid).join(',')]).trim().split('\n').filter(Boolean).map((line) => {
    const [id, etime] = line.trim().split(/\s+/);
    return [Number(id), elapsedSeconds(etime)];
  }));
  const window = (now - since) / 1000 + 1;
  return mine.filter((item) => ages.has(item.pid) && ages.get(item.pid) <= window);
}

export async function reapLeftovers(root, since, { kill = process.kill, graceMs = 2_000, ...options } = {}) {
  const found = leftovers(root, since, options);
  const signal = (name) => { for (const item of found) { try { kill(item.pid, name); } catch {} } };
  signal('SIGTERM');
  if (found.length && graceMs) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    signal('SIGKILL');
  }
  return found;
}
