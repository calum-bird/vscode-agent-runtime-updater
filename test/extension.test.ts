import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { ExtensionContext, Disposable } from 'vscode';
import type { CommandAction } from '../src/vscode/types';
import { loadWithMocks } from './helpers/modules';
import { partialMock } from './helpers/types';

test('extension activation wires both providers and owns all disposable resources', t => {
  const commands = new Map<string, CommandAction>();
  const output = { info() {}, dispose() {} };
  const vscode = {
    window: { createOutputChannel: () => output },
    workspace: { getConfiguration: () => ({ get() {} }), isTrusted: true },
    commands: {
      registerCommand: (name: string, action: CommandAction) => {
        commands.set(name, action);
        return { dispose: () => commands.delete(name) };
      },
    },
  };
  const context = {
    globalStorageUri: { fsPath: '/Code/User/globalStorage/updater' },
    globalState: { get() {}, async update() {} },
    subscriptions: [] as Disposable[],
  };
  t.after(() => {
    for (const resource of context.subscriptions) resource.dispose();
  });
  const modulePath = require.resolve('../src/extension');
  const sourceRoot = path.dirname(modulePath) + path.sep;
  const { activate } = loadWithMocks<typeof import('../src/extension')>(
    t,
    modulePath,
    (name, parent) => {
      if (name === 'vscode' && parent?.filename.startsWith(sourceRoot)) return vscode;
      return undefined;
    }
  );
  activate(partialMock<ExtensionContext>(context));
  for (const provider of ['codex', 'claude']) {
    for (const action of ['update', 'check', 'status', 'rollback', 'restore', 'restart']) {
      assert.equal(typeof commands.get(`${provider}AgentUpdater.${action}`), 'function');
    }
  }
  assert.equal(commands.size, 12);
  assert.equal(context.subscriptions.length, 14);
});
