import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext, LogOutputChannel, Disposable } from 'vscode';
import { createNotifier, restartAgentHost } from '../src/vscode/commands';
import { createCommandRunner, scheduleChecks } from '../src/vscode/lifecycle';
import type { VSCode, CommandAction } from '../src/vscode/types';
import { partialMock, assertPresent } from './helpers/types';

function fixture() {
  const messages: string[] = [];
  const errors: Array<string | Error> = [];
  const warnings: string[] = [];
  const enabled = new Map<string, boolean>();
  const vscode = {
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({
        get: (key: string, fallback: boolean) => enabled.get(key) ?? fallback,
      }),
    },
    window: {
      showInformationMessage: (message: string) => {
        messages.push(message);
      },
      showErrorMessage: (message: string) => {
        errors.push(message);
      },
    },
  };
  const output = {
    error: (error: string | Error) => errors.push(error),
    warn: (message: string) => warnings.push(message),
  };
  return { vscode, output, messages, errors, warnings, enabled };
}

test('the shared runner serializes commands and background checks, and releases busy after errors', async () => {
  const f = fixture();
  const runner = createCommandRunner(
    partialMock<VSCode>(f.vscode),
    partialMock<LogOutputChannel>(f.output)
  );
  let release: () => void = () => assert.fail('command did not start');
  const running = runner.guarded(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      })
  );
  await runner.guarded(() => assert.fail('overlapping command ran'));
  await runner.background(() => assert.fail('overlapping check ran'));
  assert.equal(f.messages.length, 1);
  release();
  await running;

  await runner.guarded(() => {
    throw new Error('command failed');
  });
  assert.match(String(f.errors[1]), /command failed/);
  await runner.background(() => {
    throw new Error('registry failed');
  });
  assert.deepEqual(f.warnings, ['registry failed']);
  f.vscode.workspace.isTrusted = false;
  await runner.background(() => assert.fail('untrusted check ran'));
  let completed = false;
  await runner.guarded(() => {
    completed = true;
  });
  assert.equal(completed, true);
});

test('scheduled checks respect provider settings, continue after failures, and stop on dispose', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  const context = { subscriptions: [] as Disposable[] };
  const calls: Array<[string, boolean | undefined]> = [];
  const providers = {
    codexAgentUpdater: {
      check: async (silent?: boolean) => {
        calls.push(['codex', silent]);
        throw new Error('offline');
      },
    },
    claudeAgentUpdater: {
      check: async (silent?: boolean) => {
        calls.push(['claude', silent]);
      },
    },
  };
  scheduleChecks(
    partialMock<VSCode>(f.vscode),
    partialMock<ExtensionContext>(context),
    createCommandRunner(partialMock<VSCode>(f.vscode), partialMock<LogOutputChannel>(f.output)),
    providers,
    partialMock<LogOutputChannel>(f.output)
  );
  t.mock.timers.tick(15_000);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [
    ['codex', true],
    ['claude', true],
  ]);
  assert.deepEqual(f.warnings, ['offline']);

  f.enabled.set('codexAgentUpdater.checkOnStartup', false);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1), ['claude', true]);
  assert.equal(calls.length, 3);
  context.subscriptions[0].dispose();
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
});

test('notification choices run through the guard and dismissals do nothing', async () => {
  const choices = ['Restart Agent Host', undefined];
  let guarded = 0;
  let restarted = 0;
  const notify = createNotifier(
    partialMock<VSCode>({ window: { showInformationMessage: async () => choices.shift() } }),
    (action: CommandAction) => {
      guarded++;
      return action();
    },
    {
      'Restart Agent Host': () => {
        restarted++;
      },
    }
  );
  notify('Updated', 'Restart Agent Host');
  notify('Updated', 'Restart Agent Host');
  await new Promise(setImmediate);
  assert.equal(guarded, 1);
  assert.equal(restarted, 1);
});

test('agent host restart requires the restart command and an affirmative dialog response', async () => {
  const calls: string[] = [];
  let available = false;
  let choice: string | undefined;
  const vscode = {
    commands: {
      getCommands: async () => (available ? ['workbench.action.chat.restartLocalAgentHost'] : []),
      executeCommand: async (command: string) => {
        calls.push(command);
      },
    },
    window: {
      showInformationMessage: (message: string) => {
        calls.push(message);
      },
      showWarningMessage: async () => choice,
    },
  };
  await restartAgentHost(partialMock<VSCode>(vscode));
  assert.match(assertPresent(calls.pop()), /Fully quit and reopen/);
  available = true;
  await restartAgentHost(partialMock<VSCode>(vscode));
  assert.equal(calls.length, 0);
  choice = 'Restart Agent Host';
  await restartAgentHost(partialMock<VSCode>(vscode));
  assert.deepEqual(calls, ['workbench.action.chat.restartLocalAgentHost']);
});
