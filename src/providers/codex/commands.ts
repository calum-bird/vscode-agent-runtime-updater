import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { errorMessage } from '../../shared/errors';
import { previousSelection } from '../../shared/history';
import { stableVersion, compareVersions } from '../../shared/versions';
import { registerCommands, createNotifier } from '../../vscode/commands';
import type { CommandServices } from '../../vscode/types';
import { createBinding } from './binding';
import { SDK_SETTING, ENV } from './constants';
import * as runtime from './runtime';

function registerCodex(context: ExtensionContext, { output, guarded, restart }: CommandServices) {
  const storage = context.globalStorageUri.fsPath;
  const log = (message: string) => output.info(message);
  const binding = createBinding(vscode, context);
  const notify = createNotifier(vscode, guarded, {
    Update: update,
    'Restart Agent Host': restart,
    'Show Status': status,
  });

  async function inspect() {
    return runtime.inspectRuntime(vscode.env.appRoot, storage, binding.read());
  }

  async function preflight() {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this window before changing the Codex runtime.');
    }
    if (process.env[ENV]) {
      throw new Error(
        'VSCODE_AGENT_HOST_CODEX_SDK_ROOT overrides the VS Code setting. Remove that environment override and fully reopen VS Code first.'
      );
    }
    const setting = binding.inspect();
    if (setting?.workspaceValue || setting?.workspaceFolderValue) {
      throw new Error('Remove the workspace SDK-root override before managing the global runtime.');
    }
    const main = await fs.readFile(path.join(vscode.env.appRoot, 'out/mainImpl.js'), 'utf8');
    if (!main.includes(SDK_SETTING) || !main.includes(ENV)) {
      throw new Error(
        'This VS Code build no longer exposes the expected SDK-root override. No changes were made.'
      );
    }
    return inspect();
  }

  function changed(message: string) {
    log(message);
    log(
      'Restart Local Agent Host when your running chats have finished. Reload Window alone may not restart the shared host.'
    );
    notify(
      `${message} Restart the local Agent Host when running chats finish.`,
      'Restart Agent Host',
      'Show Status'
    );
  }

  async function update() {
    const current = await preflight();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Updating Codex for the Agents panel',
        cancellable: false,
      },
      async progress => {
        const release = await runtime.metadata();
        stableVersion(release.version);
        if (current.version && compareVersions(current.version, release.version) >= 0) {
          log(
            `Selected Codex ${current.version}; npm latest stable ${release.version}. No downgrade or replacement needed.`
          );
          vscode.window.showInformationMessage(
            `Codex ${current.version} is already up to date. Use Show Status to inspect the selected runtime.`
          );
          return;
        }
        output.show(true);
        const root = await runtime.install(storage, release, message => {
          log(message);
          progress.report({ message });
        });
        await binding.select(root);
        changed(`Codex ${release.version} installed and selected for the next Agent Host start.`);
      }
    );
  }

  async function check(silent = false) {
    const [current, release] = await Promise.all([inspect(), runtime.metadata()]);
    stableVersion(release.version);
    log(
      `Selected: ${current.version || 'not downloaded'}; VS Code distribution: ${current.bundled}; latest stable: ${release.version}.`
    );
    if (current.version && compareVersions(current.version, release.version) >= 0) {
      if (!silent) {
        vscode.window.showInformationMessage(
          `Codex ${current.version} is up to date (latest stable: ${release.version}).`
        );
      }
      return;
    }
    if (silent && context.globalState.get('lastNotified') === release.version) return;
    await context.globalState.update('lastNotified', release.version);
    notify(
      `Codex ${release.version} is available for the Agents panel (selected: ${current.version || 'none'}).`,
      'Update',
      'Show Status'
    );
  }

  async function status() {
    const current = await inspect();
    output.show(true);
    log(`VS Code: ${current.vscodeVersion}`);
    log(`VS Code distribution pin: ${current.bundled}`);
    log(`Selected SDK root: ${current.root}`);
    log(`Selected binary: ${current.version || `unavailable (${current.error})`}`);
    log(`Managed downloads: ${storage}`);
    log(
      'Selected means on disk. The shared Agent Host keeps its current executable until restarted.'
    );
    if (current.version) {
      try {
        log(
          'Reading models using a separate app-server with your existing Codex sign-in; no inference request is sent…'
        );
        const result = await runtime.probe(runtime.binaryPath(current.root), { models: true });
        log(
          `Models reported by the selected runtime: ${result.models.map(model => model.model).join(', ')}`
        );
        log(
          'Model listing is diagnostic; actual availability also depends on account, workspace, provider, and rollout.'
        );
      } catch (error) {
        output.warn(`Model list unavailable: ${errorMessage(error)}`);
      }
    }
  }

  async function rollback() {
    await preflight();
    const state = binding.state();
    const previous = previousSelection(state);
    if (!previous) {
      vscode.window.showInformationMessage('No earlier SDK setting is saved.');
      return;
    }
    if (previous.value) {
      const version = await runtime.binaryVersion(previous.value);
      await runtime.healthCheck(previous.value, version);
    }
    await binding.rollback();
    changed('Previous SDK setting restored.');
  }

  async function restore() {
    await preflight();
    const state = binding.state();
    if (!state) {
      vscode.window.showInformationMessage('The updater has not changed your SDK setting.');
      return;
    }
    await binding.restore();
    changed('Original SDK setting restored.');
  }

  registerCommands(
    vscode,
    context,
    'codexAgentUpdater',
    { update, check, status, rollback, restore, restart },
    guarded
  );
  return { check };
}

export { registerCodex };
