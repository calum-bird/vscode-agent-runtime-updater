import fs from 'node:fs/promises';
import path from 'node:path';
import * as jsonc from 'jsonc-parser';
import { errorCode, errorMessage } from '../shared/errors';
import { userDataFromStorage } from './storage';
import type { VSCode } from './types';

const CONFIGURATION_ATTEMPTS = 50;
const CONFIGURATION_DELAY = 100;

// Some VS Code builds read the SDK setting without registering it publicly.
// In that case use the document API so comments and unrelated settings survive.
function createSdkSetting(vscode: VSCode, storage: string, key: string) {
  const config = () => vscode.workspace.getConfiguration();

  async function settingsDocument() {
    const userData = userDataFromStorage(storage);
    if (path.dirname(storage) !== path.join(userData, 'User', 'globalStorage')) {
      throw new Error('Use the default local VS Code profile to configure the shared Agent Host.');
    }
    const uri = vscode.Uri.file(path.join(userData, 'User', 'settings.json'));
    try {
      await fs.access(uri.fsPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await fs.writeFile(uri.fsPath, '{}\n', { flag: 'wx' });
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      throw new Error('Save your pending edits to User settings before updating Codex.');
    }
    return { uri, document };
  }

  async function writeDocument(root: string | undefined) {
    const { uri, document } = await settingsDocument();
    const text = document.getText();
    const errors: jsonc.ParseError[] = [];
    jsonc.parse(text, errors, { allowTrailingComma: true });
    if (errors.length) {
      throw new Error('Fix the JSON errors in User settings before updating Codex.');
    }

    const edits = jsonc.modify(text, [key], root, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
      },
    });
    const edit = new vscode.WorkspaceEdit();
    for (const change of edits) {
      const range = new vscode.Range(
        document.positionAt(change.offset),
        document.positionAt(change.offset + change.length)
      );
      edit.replace(uri, range, change.content);
    }
    if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
      throw new Error('Could not save the Codex SDK setting.');
    }
    for (let attempt = 0; attempt < CONFIGURATION_ATTEMPTS && !matches(root); attempt++) {
      await new Promise(resolve => setTimeout(resolve, CONFIGURATION_DELAY));
    }
  }

  function matches(root: string | undefined) {
    return (config().get<string>(key) || '') === (root || '');
  }

  async function write(root: string | undefined) {
    try {
      await config().update(key, root, vscode.ConfigurationTarget.Global);
    } catch (error) {
      if (!errorMessage(error).includes('not a registered configuration')) throw error;
      await writeDocument(root);
    }
    if (!matches(root)) {
      throw new Error(
        'A higher-priority setting prevented the SDK override. Inspect your VS Code settings.'
      );
    }
  }

  return {
    read: () => config().get<string>(key),
    inspect: () => config().inspect<string>(key),
    write,
  };
}

export { createSdkSetting };
