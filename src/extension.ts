import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { registerClaude } from './providers/claude/commands';
import { registerCodex } from './providers/codex/commands';
import { restartAgentHost } from './vscode/commands';
import { createCommandRunner, scheduleChecks } from './vscode/lifecycle';

function activate(context: ExtensionContext) {
  const output = vscode.window.createOutputChannel('Agent Runtime Updater', { log: true });
  context.subscriptions.push(output);
  const runner = createCommandRunner(vscode, output);
  const services = { output, guarded: runner.guarded, restart: () => restartAgentHost(vscode) };
  const codex = registerCodex(context, services);
  const claude = registerClaude(context, services);

  scheduleChecks(
    vscode,
    context,
    runner,
    { codexAgentUpdater: codex, claudeAgentUpdater: claude },
    output
  );
  output.info(
    'Ready. Run “Codex Agent Updater: Update to Latest Stable” or “Claude Agent Updater: Update to Latest Stable” from the Command Palette.'
  );
}

export { activate };
