import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { engineFor } from '../harness/engine.mjs';
import { runPiRole } from '../harness/pi-role.mjs';
import { runClaudeRole } from '../harness/claude-role.mjs';

test('sin HARNESS_ENGINE el motor sigue siendo Pi con DevExpert fijado', () => {
  const engine = engineFor({});
  assert.equal(engine.id, 'pi');
  assert.equal(engine.executor, runPiRole);
  assert.equal(engine.options.engineName, 'Pi');
  assert.equal(engine.options.provider, 'devexpert');
  assert.equal(engine.options.model, 'chat');
  assert.equal(engine.bin(engine.options), 'pi');
});

test('el motor claude fija un modelo por rol que el entorno no cambia', () => {
  const engine = engineFor({ HARNESS_ENGINE: 'claude', ANTHROPIC_MODEL: 'another-model', PI_MODEL: 'another-model', CLAUDE_TIMEOUT_MS: '5000' });
  assert.equal(engine.executor, runClaudeRole);
  assert.equal(engine.options.engineName, 'Claude Code');
  assert.equal(engine.options.provider, 'claude-code');
  assert.deepEqual(engine.options.models, { planner: 'sonnet', implementer: 'opus', validator: 'opus' });
  assert.throws(() => { engine.options.models.planner = 'haiku'; });
  assert.equal(engine.options.model, undefined);
  assert.equal(engine.options.timeoutMs, 5000);
  assert.equal(engine.bin(engine.options), 'claude');
  assert.equal(engineFor({ HARNESS_ENGINE: 'claude', CLAUDE_BIN: 'bin/fake-claude.mjs' }).options.claudeBin, resolve('bin/fake-claude.mjs'));
});

test('un motor desconocido se rechaza en vez de caer en Pi', () => {
  for (const value of ['codex', 'constructor', '']) assert.throws(() => engineFor({ HARNESS_ENGINE: value }), /HARNESS_ENGINE debe ser pi o claude/);
});
