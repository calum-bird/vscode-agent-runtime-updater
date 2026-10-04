import type { ExtensionContext, LogOutputChannel } from 'vscode';
import { errorMessage } from '../shared/errors';
import type { VSCode, CommandAction, UpdateChecker } from './types';

const STARTUP_DELAY = 15_000;
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

// All providers share one runner: an update or restart must not overlap another
// command or a scheduled check, even when it belongs to a different provider.
function createCommandRunner(vscode: VSCode, output: LogOutputChannel) {
  let busy = false;

  async function guarded(action: CommandAction) {
    if (busy) {
      vscode.window.showInformationMessage('An agent runtime updater command is already running.');
      return;
    }
    busy = true;
    try {
      await action();
    } catch (error) {
      output.error(error instanceof Error ? error : errorMessage(error));
      vscode.window.showErrorMessage(`Agent Runtime Updater: ${errorMessage(error)}`);
    } finally {
      busy = false;
    }
  }

  async function background(action: CommandAction) {
    if (busy || !vscode.workspace.isTrusted) return;
    busy = true;
    try {
      await action();
    } catch (error) {
      output.warn(errorMessage(error));
    } finally {
      busy = false;
    }
  }

  return { guarded, background };
}

function scheduleChecks(
  vscode: VSCode,
  context: ExtensionContext,
  runner: ReturnType<typeof createCommandRunner>,
  providers: Record<string, UpdateChecker>,
  output: LogOutputChannel
) {
  const check = () =>
    runner.background(async () => {
      const config = vscode.workspace.getConfiguration();
      for (const [prefix, provider] of Object.entries(providers)) {
        if (config.get(`${prefix}.checkOnStartup`, true)) {
          await provider.check(true).catch((error: unknown) => output.warn(errorMessage(error)));
        }
      }
    });
  const startup = setTimeout(check, STARTUP_DELAY);
  const daily = setInterval(check, CHECK_INTERVAL);
  context.subscriptions.push({
    dispose() {
      clearTimeout(startup);
      clearInterval(daily);
    },
  });
}

export { createCommandRunner, scheduleChecks };
