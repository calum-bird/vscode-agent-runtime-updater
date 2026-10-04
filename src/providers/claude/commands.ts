import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { previousSelection } from '../../shared/history';
import { stableVersion, compareVersions } from '../../shared/versions';
import { registerCommands, createNotifier } from '../../vscode/commands';
import type { CommandServices } from '../../vscode/types';
import { createBinding } from './binding';
import * as claude from './runtime';

function registerClaude(context: ExtensionContext, { output, guarded, restart }: CommandServices) {
  const extensionStorage = context.globalStorageUri.fsPath;
  const storage = path.join(extensionStorage, 'claude');
  const log = (message: string) => output.info(`[Claude] ${message}`);
  const binding = () => createBinding(storage);
  let restartNoticeShown = false;

  function needsFullRestart(selectedEnv: string | null) {
    return (process.env[claude.ENV] || null) !== selectedEnv;
  }

  const notify = createNotifier(vscode, guarded, {
    'Update Claude': update,
    'Restart Agent Host': restart,
    'Show Status': status,
  });

  async function inspect(api = binding()) {
    const selected = await api.inspect();
    const root =
      selected.env === selected.current ? selected.link : selected.env || process.env[claude.ENV];
    return {
      ...(await claude.inspectRuntime(vscode.env.appRoot, extensionStorage, root)),
      selection: selected,
    };
  }
  async function preflight() {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this window before changing the Claude runtime.');
    }
    const api = binding();
    const inherited = process.env[claude.ENV];
    if (inherited && inherited !== api.current) {
      throw new Error(
        `${claude.ENV} is already set by another configuration. Remove that override and fully reopen VS Code first.`
      );
    }
    const source = await fs.readFile(
      path.join(vscode.env.appRoot, 'out/vs/platform/agentHost/node/agentHostMain.js'),
      'utf8'
    );
    if (!source.includes(claude.ENV) || !source.includes('claude-agent-sdk')) {
      throw new Error('This VS Code build no longer exposes the expected Claude SDK override.');
    }
    return inspect(api);
  }
  function changed(message: string, fullRestart: boolean) {
    const instruction = fullRestart
      ? 'Fully quit and reopen VS Code from the Dock or Finder after running chats finish to activate the environment change.'
      : 'Restart the Local Agent Host after running chats finish to activate it.';
    log(`${message} ${instruction}`);
    const actions = fullRestart ? ['Show Status'] : ['Restart Agent Host', 'Show Status'];
    notify(`${message} ${instruction}`, ...actions);
  }
  async function update() {
    const current = await preflight();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating Claude for the Agents panel',
        cancellable: false,
      },
      async progress => {
        const release = await claude.metadata();
        stableVersion(release.version);
        if (current.version && compareVersions(current.version, release.version) >= 0) {
          if (
            current.selection.env === current.selection.current &&
            needsFullRestart(current.selection.current)
          ) {
            changed(`Claude SDK ${current.version} is already installed and selected.`, true);
          } else {
            vscode.window.showInformationMessage(
              `Claude Agent SDK ${current.version} is up to date (Claude Code ${current.binary}).`
            );
          }
          return;
        }
        output.show(true);
        const root = await claude.install(storage, release, message => {
          log(message);
          progress.report({ message });
        });
        const api = binding();
        await api.select(root);
        changed(
          `Claude SDK ${release.version} / Claude Code ${release.claudeCodeVersion} installed and selected.`,
          needsFullRestart(api.current)
        );
      }
    );
  }
  async function check(silent = false) {
    if (process.platform !== 'darwin') return;
    const [current, release] = await Promise.all([inspect(), claude.metadata()]);
    stableVersion(release.version);
    log(
      `Selected SDK: ${current.version || 'not downloaded'}; VS Code pin: ${current.bundled}; latest SDK: ${release.version} / Claude Code ${release.claudeCodeVersion}.`
    );
    if (
      !restartNoticeShown &&
      current.selection.env === current.selection.current &&
      needsFullRestart(current.selection.current)
    ) {
      restartNoticeShown = true;
      vscode.window.showInformationMessage(
        'Claude runtime is selected but this VS Code process did not inherit its override. Fully quit and reopen VS Code from the Dock or Finder to activate it.'
      );
    }
    if (current.version && compareVersions(current.version, release.version) >= 0) {
      if (!silent) {
        vscode.window.showInformationMessage(`Claude SDK ${current.version} is up to date.`);
      }
      return;
    }
    if (silent && context.globalState.get('claudeLastNotified') === release.version) return;
    await context.globalState.update('claudeLastNotified', release.version);
    notify(
      `Claude SDK ${release.version} / Claude Code ${release.claudeCodeVersion} is available for the Agents panel.`,
      'Update Claude',
      'Show Status'
    );
  }
  async function status() {
    const current = await inspect();
    output.show(true);
    log(`VS Code ${current.vscodeVersion}; distribution SDK pin: ${current.bundled}.`);
    log(
      `Selected SDK: ${current.version || 'not downloaded'}; Claude Code binary: ${current.binary || 'not downloaded'}.`
    );
    log(`Selected root: ${current.root}`);
    log(`Persistent user LaunchAgent: ${current.selection.plistPath}`);
    log(`Inherited override: ${process.env[claude.ENV] || '(none)'}`);
    log(
      `Next application launch override: ${current.selection.env || '(none; use VS Code distribution)'}`
    );
    log(
      'The existing Agent Host retains its loaded SDK until restarted. First activation and restoring the original environment require quitting and reopening VS Code.'
    );
  }
  async function rollback() {
    await preflight();
    const api = binding();
    const { state } = await api.inspect();
    const previous = previousSelection(state);
    if (previous?.link) {
      const { sdk } = await claude.versions(previous.link);
      await claude.healthCheck(previous.link, sdk);
    }
    if (!(await api.rollback())) {
      vscode.window.showInformationMessage('No earlier Claude runtime selection is saved.');
      return;
    }
    const selected = await api.inspect();
    changed('Previous Claude runtime selection restored.', needsFullRestart(selected.env));
  }
  async function restore() {
    await preflight();
    const api = binding();
    if (!(await api.restore())) {
      vscode.window.showInformationMessage('The updater has not changed your Claude runtime.');
      return;
    }
    const selected = await api.inspect();
    changed('Original Claude environment restored.', needsFullRestart(selected.env));
  }
  registerCommands(
    vscode,
    context,
    'claudeAgentUpdater',
    { update, check, status, rollback, restore, restart },
    guarded
  );
  return { check };
}
export { registerClaude };
