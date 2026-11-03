import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { elapsedSeconds, leftovers, reapLeftovers } from '../harness/reap.mjs';
import { FeatureQueue } from '../harness/queue.mjs';
import { StateStore } from '../harness/state-store.mjs';
import { inspectProject } from '../harness/project-contract.mjs';
import { fixture, feature, fakeExecutor, until } from './fixtures.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Like `./gradlew run &`: its own process group, so killing the role's group does not reach it.
const background = (cwd) => { const child = spawn('sleep', ['60'], { cwd, detached: true, stdio: 'ignore' }); child.unref(); return child.pid; };

test('etime de ps se convierte a segundos', () => {
  assert.equal(elapsedSeconds('00:05'), 5);
  assert.equal(elapsedSeconds('12:34'), 754);
  assert.equal(elapsedSeconds('01:00:00'), 3600);
  assert.equal(elapsedSeconds('07-22:45:05'), 686_705);
});

test('solo cuenta lo que arrancó durante el rol dentro del worktree', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reap-')));
  const lsof = [`p10\ncgradlew\nfcwd\nn${root}`, `p11\ncjava\nfcwd\nn${root}/desktopApp`, `p12\nczsh\nfcwd\nn${root}`, `p13\ncnode\nfcwd\nn${root}-other`, 'p14\ncvim\nfcwd\nn/'].join('\n');
  const run = (binary, args) => (binary === 'lsof' ? lsof : (assert.deepEqual(args, ['-o', 'pid=,etime=', '-p', '10,11,12']), '   10  00:30\n   11 00:29\n   12 01:00:00\n'));
  const found = leftovers(root, Date.now() - 60_000, { run });
  assert.deepEqual(found.map(({ pid, command }) => [pid, command]), [[10, 'gradlew'], [11, 'java']]);
});

test('cierra un proceso en segundo plano del rol y deja el que ya estaba', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reap-')));
  mkdirSync(join(root, 'app'));
  const before = background(root);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const since = Date.now();
  const leftover = background(join(root, 'app'));
  await until(() => leftovers(root, since).length === 1);
  const reaped = await reapLeftovers(root, since, { graceMs: 200 });
  assert.deepEqual(reaped.map((item) => item.pid), [leftover]);
  await until(() => !alive(leftover));
  assert.equal(alive(before), true);
  process.kill(before, 'SIGKILL');
});

test('el flujo cierra lo que el rol deja en marcha y lo cuenta en la actividad', async () => {
  let pid;
  const executor = fakeExecutor({ hook: ({ role, cwd }) => { if (role.name === 'implementer') pid = background(cwd); } });
  const queue = new FeatureQueue({ store: new StateStore(join(fixture(), 'state.json')), executor, piVersion: 'fixture' });
  queue.select(inspectProject(fixture([feature('search')])));
  queue.enqueue(['search']);
  await until(() => queue.data.runs[0].status === 'review', 20_000);
  assert.equal(alive(pid), false);
  assert.ok(queue.data.runs[0].events.some((event) => event.level === 'warn' && /implementer dejó un proceso[^]*sleep/.test(event.message)));
  await queue.close();
});
