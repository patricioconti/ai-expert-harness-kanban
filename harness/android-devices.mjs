import { spawnSync } from 'node:child_process';

/** Serials adb reports as ready right now, or null when adb cannot tell (then every configured device counts). */
export function connectedDevices({ adb = 'adb', spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(adb, ['devices'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return null;
  return new Set(result.stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter(([serial, state]) => serial && state === 'device').map(([serial]) => serial));
}
