'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const claude = require('./claude-runtime');
const shared = require('./runtime');
const { createBinding } = require('./claude-binding');

function registerClaude(context, { output, guarded, restart }) {
  const extensionStorage = context.globalStorageUri.fsPath;
  const storage = path.join(extensionStorage, 'claude');
  const log = message => output.info(`[Claude] ${message}`);
  const binding = () => createBinding(storage);
  let restartNoticeShown = false;

  async function inspect() {
    const selected = await binding().inspect();
    const root = selected.env === selected.current ? selected.link : selected.env || process.env[claude.ENV];
    return { ...await claude.inspectRuntime(vscode.env.appRoot, extensionStorage, root), selection: selected };
  }
  async function preflight() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this window before changing the Claude runtime.');
    const api = binding();
    const inherited = process.env[claude.ENV];
    if (inherited && inherited !== api.current) throw new Error(`${claude.ENV} is already set by another configuration. Remove that override and fully reopen VS Code first.`);
    const source = await fs.readFile(path.join(vscode.env.appRoot, 'out/vs/platform/agentHost/node/agentHostMain.js'), 'utf8');
    if (!source.includes(claude.ENV) || !source.includes('claude-agent-sdk')) throw new Error('This VS Code build no longer exposes the expected Claude SDK override.');
    return inspect();
  }
  function changed(message, fullRestart) {
    const instruction = fullRestart
      ? 'Fully quit and reopen VS Code from the Dock or Finder after running chats finish to activate the environment change.'
      : 'Restart the Local Agent Host after running chats finish to activate it.';
    log(`${message} ${instruction}`);
    void vscode.window.showInformationMessage(`${message} ${instruction}`, ...(fullRestart ? ['Show Status'] : ['Restart Agent Host', 'Show Status']))
      .then(choice => {
        if (choice === 'Restart Agent Host') return guarded(restart);
        if (choice === 'Show Status') return guarded(status);
      });
  }
  async function update() {
    const current = await preflight();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating Claude for the Agents panel', cancellable: false }, async progress => {
      const release = await claude.metadata();
      shared.stableVersion(release.version);
      if (current.version && shared.compareVersions(current.version, release.version) >= 0) {
        if (current.selection.env === current.selection.current && process.env[claude.ENV] !== current.selection.current) {
          changed(`Claude SDK ${current.version} is already installed and selected.`, true);
        } else vscode.window.showInformationMessage(`Claude Agent SDK ${current.version} is up to date (Claude Code ${current.binary}).`);
        return;
      }
      output.show(true);
      const root = await claude.install(storage, release, message => { log(message); progress.report({ message }); });
      await binding().select(root);
      changed(`Claude SDK ${release.version} / Claude Code ${release.claudeCodeVersion} installed and selected.`, process.env[claude.ENV] !== binding().current);
    });
  }
  async function check(silent = false) {
    if (process.platform !== 'darwin') return;
    const [current, release] = await Promise.all([inspect(), claude.metadata()]);
    shared.stableVersion(release.version);
    log(`Selected SDK: ${current.version || 'not downloaded'}; VS Code pin: ${current.bundled}; latest SDK: ${release.version} / Claude Code ${release.claudeCodeVersion}.`);
    if (!restartNoticeShown && current.selection.env === current.selection.current && process.env[claude.ENV] !== current.selection.current) {
      restartNoticeShown = true;
      vscode.window.showInformationMessage('Claude runtime is selected but this VS Code process did not inherit its override. Fully quit and reopen VS Code from the Dock or Finder to activate it.');
    }
    if (current.version && shared.compareVersions(current.version, release.version) >= 0) {
      if (!silent) vscode.window.showInformationMessage(`Claude SDK ${current.version} is up to date.`);
      return;
    }
    if (silent && context.globalState.get('claudeLastNotified') === release.version) return;
    await context.globalState.update('claudeLastNotified', release.version);
    void vscode.window.showInformationMessage(`Claude SDK ${release.version} / Claude Code ${release.claudeCodeVersion} is available for the Agents panel.`, 'Update Claude', 'Show Status')
      .then(choice => {
        if (choice === 'Update Claude') return guarded(update);
        if (choice === 'Show Status') return guarded(status);
      });
  }
  async function status() {
    const current = await inspect();
    output.show(true);
    log(`VS Code ${current.vscodeVersion}; distribution SDK pin: ${current.bundled}.`);
    log(`Selected SDK: ${current.version || 'not downloaded'}; Claude Code binary: ${current.binary || 'not downloaded'}.`);
    log(`Selected root: ${current.root}`);
    log(`Persistent user LaunchAgent: ${current.selection.plistPath}`);
    log(`Inherited override: ${process.env[claude.ENV] || '(none)'}`);
    log(`Next application launch override: ${current.selection.env || '(none; use VS Code distribution)'}`);
    log('The existing Agent Host retains its loaded SDK until restarted. First activation and restoring the original environment require quitting and reopening VS Code.');
  }
  async function rollback() {
    await preflight();
    const api = binding(), state = (await api.inspect()).state;
    const previous = state?.pending || state?.history.at(-1);
    if (previous?.link) await claude.healthCheck(previous.link, (await claude.versions(previous.link)).sdk);
    if (!await api.rollback()) { vscode.window.showInformationMessage('No earlier Claude runtime selection is saved.'); return; }
    const selected = await api.inspect();
    changed('Previous Claude runtime selection restored.', (process.env[claude.ENV] || null) !== selected.env);
  }
  async function restore() {
    await preflight();
    const api = binding();
    if (!await api.restore()) { vscode.window.showInformationMessage('The updater has not changed your Claude runtime.'); return; }
    changed('Original Claude environment restored.', (process.env[claude.ENV] || null) !== (await api.inspect()).env);
  }
  for (const [name, action] of Object.entries({ update, check, status, rollback, restore, restart })) {
    context.subscriptions.push(vscode.commands.registerCommand(`claudeAgentUpdater.${name}`, () => guarded(action)));
  }
  return { check };
}
module.exports = { registerClaude };
