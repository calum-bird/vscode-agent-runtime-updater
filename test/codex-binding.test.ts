import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { CodexSelectionState } from '../src/providers/codex/binding';
import { createBinding } from '../src/providers/codex/binding';
import type { VSCode } from '../src/vscode/types';
import { partialMock, assertPresent } from './helpers/types';

function fixture(initial?: string) {
  let value = initial;
  let saved: CodexSelectionState | undefined;
  let failure: Error | undefined;
  const setting = {
    get: () => value,
    inspect: () => ({ globalValue: value }),
    update: async (_key: string, root: string | undefined) => {
      assert.ok(assertPresent(saved).pending, 'recovery point is saved before changing settings');
      if (failure) throw failure;
      value = root;
    },
  };
  const vscode = {
    workspace: { getConfiguration: () => setting },
    ConfigurationTarget: { Global: 1 },
  };
  const context = {
    globalStorageUri: { fsPath: '/Code/User/globalStorage/updater' },
    globalState: {
      get: () => saved,
      update: async (_key: string, state: CodexSelectionState) => {
        saved = state;
      },
    },
  };
  return {
    binding: createBinding(partialMock<VSCode>(vscode), partialMock<ExtensionContext>(context)),
    fail: () => {
      failure = new Error('setting write failed');
    },
    recover: () => {
      failure = undefined;
    },
  };
}

test('Codex selection preserves its original setting and supports rollback after restore', async () => {
  const { binding } = fixture('/original');
  await binding.select('/one');
  await binding.select('/two');
  assert.equal(assertPresent(binding.state()).history.length, 2);
  assert.equal(await binding.rollback(), true);
  assert.equal(binding.read(), '/one');
  assert.equal(await binding.restore(), true);
  assert.equal(binding.read(), '/original');
  assert.equal(await binding.rollback(), true);
  assert.equal(binding.read(), '/one');
});

test('Codex restore removes a setting that was originally absent', async () => {
  const { binding } = fixture();
  assert.equal(await binding.rollback(), false);
  assert.equal(await binding.restore(), false);
  await binding.select('/one');
  await binding.restore();
  assert.equal(binding.read(), undefined);
  assert.equal(assertPresent(binding.state()).original.present, false);
});

test('Codex failed writes retain a pending recovery point without consuming history', async () => {
  const f = fixture('/original');
  await f.binding.select('/one');
  const history = assertPresent(f.binding.state()).history;
  f.fail();
  await assert.rejects(f.binding.select('/two'), /setting write failed/);
  assert.deepEqual(assertPresent(f.binding.state()).pending, { present: true, value: '/one' });
  assert.deepEqual(assertPresent(f.binding.state()).history, history);
  f.recover();
  await f.binding.rollback();
  assert.equal(f.binding.read(), '/one');
  assert.equal(assertPresent(f.binding.state()).pending, undefined);
  assert.deepEqual(assertPresent(f.binding.state()).history, history);
});

test('Codex selection limits history to the last twenty recovery points', async () => {
  const { binding } = fixture('/original');
  for (let i = 0; i < 25; i++) await binding.select(`/sdk/${i}`);
  assert.equal(assertPresent(binding.state()).history.length, 20);
  assert.equal(assertPresent(binding.state()).history[0].value, '/sdk/4');
  assert.equal(assertPresent(binding.state()).original.value, '/original');
});
