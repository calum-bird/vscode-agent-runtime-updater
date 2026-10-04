import assert from 'node:assert/strict';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionContext, Disposable } from 'vscode';
import { ENV } from '../src/providers/claude/runtime';
import * as shared from '../src/shared/versions';
import type { CommandAction, CommandServices } from '../src/vscode/types';
import { loadWithMocks } from './helpers/modules';
import { partialMock, assertPresent } from './helpers/types';

function fixture(t: TestContext) {
  const inherited = process.env[ENV];
  delete process.env[ENV];
  t.after(() => {
    if (inherited === undefined) delete process.env[ENV];
    else process.env[ENV] = inherited;
  });

  const commands = new Map<string, CommandAction>();
  const messages: string[][] = [];
  const calls: string[][] = [];
  const notices = new Map<string, string>();
  const selection: {
    current: string;
    env: string | null;
    link: string | null;
    plistPath: string;
    state: { pending?: { link: string }; history: Array<{ link: string }> } | null;
  } = {
    current: '/storage/claude/current',
    env: null,
    link: null,
    plistPath: '/home/Library/LaunchAgents/claude.plist',
    state: null,
  };
  const current = { version: '0.3.1', binary: '2.1.1', bundled: '0.3.1' };
  const release = { version: '0.3.2', claudeCodeVersion: '2.1.2' };
  const api = {
    current: selection.current,
    inspect: async () => selection,
    select: async (root: string) => {
      calls.push(['select', root]);
      selection.env = selection.current;
      selection.link = root;
    },
    rollback: async () => {
      calls.push(['rollback']);
      return true;
    },
    restore: async () => {
      calls.push(['restore']);
      return false;
    },
  };
  const claude = {
    ENV,
    inspectRuntime: async (_app: string, _storage: string, root?: string) => ({ ...current, root }),
    metadata: async () => release,
    install: async (): Promise<string> => {
      calls.push(['install']);
      return '/sdk/new';
    },
    versions: async (root: string) => {
      calls.push(['versions', root]);
      return { sdk: '0.3.0' };
    },
    healthCheck: async (root: string, version: string): Promise<void> => {
      calls.push(['healthCheck', root, version]);
    },
  };
  const vscode = {
    workspace: { isTrusted: true },
    env: { appRoot: '/app' },
    ProgressLocation: { Notification: 1 },
    commands: {
      registerCommand: (name: string, action: CommandAction) => {
        commands.set(name, action);
        return {};
      },
    },
    window: {
      withProgress: async (
        _options: unknown,
        action: (progress: { report(): void }) => Promise<unknown>
      ) => action({ report() {} }),
      showInformationMessage: async (...args: string[]) => {
        messages.push(args);
      },
    },
  };
  const dependencies: Record<string, unknown> = {
    vscode,
    'node:fs/promises': { readFile: async () => `${ENV} claude-agent-sdk` },
    './runtime': claude,
    '../../shared/versions': shared,
    './binding': { createBinding: () => api },
  };
  const modulePath = require.resolve('../src/providers/claude/commands');
  const { registerClaude } = loadWithMocks<typeof import('../src/providers/claude/commands')>(
    t,
    modulePath,
    (name, parent) => {
      if (parent?.filename === modulePath && Object.hasOwn(dependencies, name)) {
        return dependencies[name];
      }
      return undefined;
    }
  );

  const context = {
    globalStorageUri: { fsPath: path.join('/storage') },
    globalState: {
      get: (key: string) => notices.get(key),
      update: async (key: string, value: string) => {
        notices.set(key, value);
      },
    },
    subscriptions: [] as Disposable[],
  };
  const registered = registerClaude(
    partialMock<ExtensionContext>(context),
    partialMock<CommandServices>({
      output: { info() {}, show() {} },
      guarded: (action: CommandAction) => action(),
      restart: async () => {
        calls.push(['restart']);
      },
    })
  );
  return {
    api,
    claude,
    vscode,
    selection,
    current,
    release,
    calls,
    messages,
    registered,
    context,
    run: async (name: string) => {
      await assertPresent(commands.get(`claudeAgentUpdater.${name}`))();
    },
    commands,
  };
}

test('Claude commands register all actions and avoid downgrading the selected SDK', async t => {
  const f = fixture(t);
  assert.equal(f.commands.size, 6);
  assert.equal(f.context.subscriptions.length, 6);
  f.current.version = '0.3.3';
  await f.run('update');
  assert.equal(f.calls.length, 0);
  assert.match(f.messages[0][0], /up to date/);
});

test('Claude update selects only a successfully installed SDK and offers the right restart', async t => {
  const f = fixture(t);
  f.claude.install = async () => {
    throw new Error('handshake failed');
  };
  await assert.rejects(f.run('update'), /handshake failed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 0);

  f.claude.install = async () => {
    f.calls.push(['install']);
    return '/sdk/new';
  };
  await f.run('update');
  assert.deepEqual(f.calls, [['install'], ['select', '/sdk/new']]);
  assert.match(f.messages[0][0], /Fully quit and reopen/);
  assert.deepEqual(f.messages[0].slice(1), ['Show Status']);

  process.env[ENV] = f.selection.current;
  await f.run('update');
  assert.match(f.messages[1][0], /Restart the Local Agent Host/);
  assert.deepEqual(f.messages[1].slice(1), ['Restart Agent Host', 'Show Status']);
});

test('Claude rollback checks the pending SDK before changing the selection', async t => {
  const f = fixture(t);
  f.selection.state = {
    pending: { link: '/sdk/interrupted' },
    history: [{ link: '/sdk/history' }],
  };
  f.claude.healthCheck = async () => {
    throw new Error('unhealthy SDK');
  };
  await assert.rejects(f.run('rollback'), /unhealthy SDK/);
  assert.deepEqual(f.calls, [['versions', '/sdk/interrupted']]);

  f.claude.healthCheck = async (root, version) => {
    f.calls.push(['healthCheck', root, version]);
  };
  f.calls.length = 0;
  await f.run('rollback');
  assert.deepEqual(f.calls, [
    ['versions', '/sdk/interrupted'],
    ['healthCheck', '/sdk/interrupted', '0.3.0'],
    ['rollback'],
  ]);
});

test('Claude preflight rejects untrusted windows and foreign overrides before installing', async t => {
  const f = fixture(t);
  f.vscode.workspace.isTrusted = false;
  await assert.rejects(f.run('update'), /Trust this window/);
  f.vscode.workspace.isTrusted = true;
  process.env[ENV] = '/someone/else/sdk';
  await assert.rejects(f.run('update'), /already set by another configuration/);
  assert.equal(f.calls.length, 0);
});

test(
  'Claude background checks notify once per release',
  { skip: process.platform !== 'darwin' },
  async t => {
    const f = fixture(t);
    await f.registered.check(true);
    await f.registered.check(true);
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.messages[0].slice(1), ['Update Claude', 'Show Status']);
    f.release.version = '0.3.3';
    await f.registered.check(true);
    assert.equal(f.messages.length, 2);
  }
);
