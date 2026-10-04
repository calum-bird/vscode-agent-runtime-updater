import type { ExtensionContext } from 'vscode';
import type { VSCode, CommandAction, CommandGuard } from './types';

function registerCommands(
  vscode: VSCode,
  context: ExtensionContext,
  prefix: string,
  actions: Record<string, CommandAction>,
  guarded: CommandGuard
) {
  for (const [name, action] of Object.entries(actions)) {
    const command = vscode.commands.registerCommand(`${prefix}.${name}`, () => guarded(action));
    context.subscriptions.push(command);
  }
}

function createNotifier(
  vscode: VSCode,
  guarded: CommandGuard,
  actions: Record<string, CommandAction>
) {
  return (message: string, ...choices: string[]) => {
    void vscode.window.showInformationMessage(message, ...choices).then(choice => {
      if (choice !== undefined && Object.hasOwn(actions, choice)) return guarded(actions[choice]);
    });
  };
}

async function restartAgentHost(vscode: VSCode) {
  const command = 'workbench.action.chat.restartLocalAgentHost';
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(command)) {
    vscode.window.showInformationMessage(
      'Fully quit and reopen VS Code to load the selected runtime.'
    );
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    'Restart the local Agent Host? This interrupts running agent turns in all VS Code windows.',
    { modal: true },
    'Restart Agent Host'
  );
  if (answer === 'Restart Agent Host') await vscode.commands.executeCommand(command);
}

export { registerCommands, createNotifier, restartAgentHost };
