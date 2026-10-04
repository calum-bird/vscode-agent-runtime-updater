'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const runtime = require('./runtime');
const jsonc = require('jsonc-parser');

function activate(context) {
  const output = vscode.window.createOutputChannel('Agent Runtime Updater', { log: true });
  context.subscriptions.push(output);
  const storage = context.globalStorageUri.fsPath;
  const config = () => vscode.workspace.getConfiguration();
  const log = message => output.info(message);
  let busy = false;

  async function inspect() {
    return runtime.inspectRuntime(vscode.env.appRoot, storage, config().get(runtime.SDK_SETTING));
  }

  async function preflight() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this window before changing the Codex runtime.');
    if (process.env.VSCODE_AGENT_HOST_CODEX_SDK_ROOT) {
      throw new Error('VSCODE_AGENT_HOST_CODEX_SDK_ROOT overrides the VS Code setting. Remove that environment override and fully reopen VS Code first.');
    }
    const setting = config().inspect(runtime.SDK_SETTING);
    if (setting?.workspaceValue || setting?.workspaceFolderValue) {
      throw new Error('Remove the workspace SDK-root override before managing the global runtime.');
    }
    const main = await fs.readFile(path.join(vscode.env.appRoot, 'out/mainImpl.js'), 'utf8');
    if (!main.includes(runtime.SDK_SETTING) || !main.includes('VSCODE_AGENT_HOST_CODEX_SDK_ROOT')) {
      throw new Error('This VS Code build no longer exposes the expected SDK-root override. No changes were made.');
    }
    return inspect();
  }

  async function restart() {
    const commands = await vscode.commands.getCommands(true);
    const command = 'workbench.action.chat.restartLocalAgentHost';
    if (!commands.includes(command)) {
      vscode.window.showInformationMessage('Fully quit and reopen VS Code to load the selected runtime.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      'Restart the local Agent Host? This interrupts running agent turns in all VS Code windows.',
      { modal: true }, 'Restart Agent Host');
    if (answer === 'Restart Agent Host') await vscode.commands.executeCommand(command);
  }

  async function changed(message) {
    log(message);
    log('Restart Local Agent Host when your running chats have finished. Reload Window alone may not restart the shared host.');
    void vscode.window.showInformationMessage(
      `${message} Restart the local Agent Host when running chats finish.`, 'Restart Agent Host', 'Show Status')
      .then(choice => {
        if (choice === 'Restart Agent Host') return guarded(restart);
        if (choice === 'Show Status') return guarded(status);
      });
  }

  async function setRoot(root, recordHistory = true) {
    const before = config().inspect(runtime.SDK_SETTING)?.globalValue;
    const state = context.globalState.get('management', { original: { present: before !== undefined, value: before }, history: [] });
    // Persist the recovery point before changing VS Code's setting.
    await context.globalState.update('management', { ...state, pending: { present: before !== undefined, value: before } });
    try {
      await config().update(runtime.SDK_SETTING, root, vscode.ConfigurationTarget.Global);
    } catch (error) {
      if (!error.message.includes('not a registered configuration')) throw error;
      // Stable hides this development setting from the configuration registry,
      // although the main process reads it. Edit the default User settings via
      // VS Code's document API, preserving JSONC comments and unrelated values.
      const userData = runtime.userDataFromStorage(storage);
      if (path.dirname(storage) !== path.join(userData, 'User', 'globalStorage')) {
        throw new Error('Use the default local VS Code profile to configure the shared Agent Host.');
      }
      const uri = vscode.Uri.file(path.join(userData, 'User', 'settings.json'));
      try { await fs.access(uri.fsPath); }
      catch (missing) {
        if (missing.code !== 'ENOENT') throw missing;
        await fs.writeFile(uri.fsPath, '{}\n', { flag: 'wx' });
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty) throw new Error('Save your pending edits to User settings before updating Codex.');
      const text = document.getText(), errors = [];
      jsonc.parse(text, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error('Fix the JSON errors in User settings before updating Codex.');
      const edits = jsonc.modify(text, [runtime.SDK_SETTING], root, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' },
      });
      const edit = new vscode.WorkspaceEdit();
      for (const change of edits) edit.replace(uri, new vscode.Range(document.positionAt(change.offset), document.positionAt(change.offset + change.length)), change.content);
      if (!await vscode.workspace.applyEdit(edit) || !await document.save()) throw new Error('Could not save the Codex SDK setting.');
      for (let attempts = 0; attempts < 50 && (config().get(runtime.SDK_SETTING) || '') !== (root || ''); attempts++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const after = config().get(runtime.SDK_SETTING);
    if ((after || '') !== (root || '')) throw new Error('A higher-priority setting prevented the SDK override. Inspect your VS Code settings.');
    await context.globalState.update('management', {
      ...state,
      history: recordHistory ? [...state.history, { present: before !== undefined, value: before }].slice(-20) : state.history,
      pending: undefined,
    });
  }

  async function update() {
    const current = await preflight();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating Codex for the Agents panel', cancellable: false }, async progress => {
      const release = await runtime.metadata();
      runtime.stableVersion(release.version);
      if (current.version && runtime.compareVersions(current.version, release.version) >= 0) {
        log(`Selected Codex ${current.version}; npm latest stable ${release.version}. No downgrade or replacement needed.`);
        vscode.window.showInformationMessage(`Codex ${current.version} is already up to date. Use Show Status to inspect the selected runtime.`);
        return;
      }
      output.show(true);
      const root = await runtime.install(storage, release, message => { log(message); progress.report({ message }); });
      await setRoot(root);
      await changed(`Codex ${release.version} installed and selected for the next Agent Host start.`);
    });
  }

  async function check(silent = false) {
    const [current, release] = await Promise.all([inspect(), runtime.metadata()]);
    runtime.stableVersion(release.version);
    log(`Selected: ${current.version || 'not downloaded'}; VS Code distribution: ${current.bundled}; latest stable: ${release.version}.`);
    if (current.version && runtime.compareVersions(current.version, release.version) >= 0) {
      if (!silent) vscode.window.showInformationMessage(`Codex ${current.version} is up to date (latest stable: ${release.version}).`);
      return;
    }
    if (silent && context.globalState.get('lastNotified') === release.version) return;
    await context.globalState.update('lastNotified', release.version);
    void vscode.window.showInformationMessage(
      `Codex ${release.version} is available for the Agents panel (selected: ${current.version || 'none'}).`, 'Update', 'Show Status')
      .then(choice => {
        if (choice === 'Update') return guarded(update);
        if (choice === 'Show Status') return guarded(status);
      });
  }

  async function status() {
    const current = await inspect();
    output.show(true);
    log(`VS Code: ${current.vscodeVersion}`);
    log(`VS Code distribution pin: ${current.bundled}`);
    log(`Selected SDK root: ${current.root}`);
    log(`Selected binary: ${current.version || `unavailable (${current.error})`}`);
    log(`Managed downloads: ${storage}`);
    log('Selected means on disk. The shared Agent Host keeps its current executable until restarted.');
    if (current.version) {
      try {
        log('Reading models using a separate app-server with your existing Codex sign-in; no inference request is sent…');
        const result = await runtime.probe(runtime.binaryPath(current.root), { models: true });
        log(`Models reported by the selected runtime: ${result.models.map(model => model.model).join(', ')}`);
        log('Model listing is diagnostic; actual availability also depends on account, workspace, provider, and rollout.');
      } catch (error) { output.warn(`Model list unavailable: ${error.message}`); }
    }
  }

  async function rollback() {
    await preflight();
    const state = context.globalState.get('management');
    const previous = state?.pending || state?.history?.at(-1);
    if (!previous) { vscode.window.showInformationMessage('No earlier SDK setting is saved.'); return; }
    if (previous.value) {
      const version = await runtime.binaryVersion(previous.value);
      await runtime.healthCheck(previous.value, version);
    }
    await setRoot(previous.present ? previous.value : undefined, false);
    await context.globalState.update('management', { ...state, pending: undefined, history: state.pending ? state.history : state.history.slice(0, -1) });
    await changed('Previous SDK setting restored.');
  }

  async function restore() {
    await preflight();
    const state = context.globalState.get('management');
    if (!state) { vscode.window.showInformationMessage('The updater has not changed your SDK setting.'); return; }
    await setRoot(state.original.present ? state.original.value : undefined);
    await changed('Original SDK setting restored.');
  }

  async function guarded(action) {
    if (busy) { vscode.window.showInformationMessage('An agent runtime updater command is already running.'); return; }
    busy = true;
    try { await action(); }
    catch (error) { output.error(error); vscode.window.showErrorMessage(`Agent Runtime Updater: ${error.message}`); }
    finally { busy = false; }
  }
  for (const [name, action] of Object.entries({ update, check, status, rollback, restore, restart })) {
    context.subscriptions.push(vscode.commands.registerCommand(`codexAgentUpdater.${name}`, () => guarded(action)));
  }
  const claude = require('./claude-commands').registerClaude(context, { output, guarded, restart });
  const backgroundCheck = () => {
    if (!busy && vscode.workspace.isTrusted) {
      // Background failures go to Output, without recurring error popups.
      busy = true;
      (async () => {
        if (config().get('codexAgentUpdater.checkOnStartup', true)) await check(true).catch(error => output.warn(error.message));
        if (config().get('claudeAgentUpdater.checkOnStartup', true)) await claude.check(true).catch(error => output.warn(error.message));
      })().finally(() => { busy = false; });
    }
  };
  const startup = setTimeout(backgroundCheck, 15_000);
  const daily = setInterval(backgroundCheck, 24 * 60 * 60 * 1000);
  context.subscriptions.push({ dispose() { clearTimeout(startup); clearInterval(daily); } });
  log('Ready. Run “Codex Agent Updater: Update to Latest Stable” or “Claude Agent Updater: Update to Latest Stable” from the Command Palette.');
}

module.exports = { activate };
