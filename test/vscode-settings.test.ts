import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import * as jsonc from 'jsonc-parser';
import { SDK_SETTING } from '../src/providers/codex/constants';
import { createSdkSetting } from '../src/vscode/settings';
import type { VSCode } from '../src/vscode/types';
import { temporary } from './helpers/files';
import { partialMock } from './helpers/types';

interface TestRange {
  start: number;
  end: number;
}
interface TestEdit {
  changes: Array<TestRange & { content: string }>;
}

async function fixture(t: TestContext, initialText: string) {
  const root = await temporary(t);
  const user = path.join(root, 'Code', 'User');
  const file = path.join(user, 'settings.json');
  await fs.mkdir(user, { recursive: true });
  await fs.writeFile(file, initialText);
  let text = initialText;
  let selected = jsonc.parse(text)?.[SDK_SETTING];
  const document = {
    isDirty: false,
    eol: 1,
    getText: () => text,
    positionAt: (offset: number) => offset,
    save: async () => {
      await fs.writeFile(file, text);
      selected = jsonc.parse(text)[SDK_SETTING];
      return true;
    },
  };
  const configuration = {
    get: () => selected,
    inspect: () => ({ globalValue: selected }),
    update: async (): Promise<void> => {
      throw new Error('not a registered configuration');
    },
  };
  const vscode = {
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    EndOfLine: { CRLF: 2 },
    ConfigurationTarget: { Global: 1 },
    Range: class {
      constructor(
        public start: number,
        public end: number
      ) {}
    },
    WorkspaceEdit: class {
      changes: TestEdit['changes'] = [];
      replace(_uri: unknown, range: TestRange, content: string) {
        this.changes.push({ ...range, content });
      }
    },
    workspace: {
      getConfiguration: () => configuration,
      openTextDocument: async () => document,
      applyEdit: async (edit: TestEdit) => {
        for (const change of edit.changes.sort((left, right) => right.start - left.start)) {
          text = text.slice(0, change.start) + change.content + text.slice(change.end);
        }
        return true;
      },
    },
  };
  return {
    file,
    document,
    configuration,
    vscode,
    storage: path.join(user, 'globalStorage', 'updater'),
    setting: createSdkSetting(
      partialMock<VSCode>(vscode),
      path.join(user, 'globalStorage', 'updater'),
      SDK_SETTING
    ),
  };
}

test('the hidden SDK setting fallback preserves JSONC comments and unrelated settings', async t => {
  const original = '{\n  // Keep this preference\n  "editor.fontSize": 15,\n}\n';
  const f = await fixture(t, original);
  await f.setting.write('/sdk/new');
  const updated = await fs.readFile(f.file, 'utf8');
  assert.match(updated, /\/\/ Keep this preference/);
  assert.equal(jsonc.parse(updated)['editor.fontSize'], 15);
  assert.equal(f.setting.read(), '/sdk/new');
  await f.setting.write(undefined);
  const restored = await fs.readFile(f.file, 'utf8');
  assert.match(restored, /\/\/ Keep this preference/);
  assert.equal(jsonc.parse(restored)['editor.fontSize'], 15);
  assert.equal(Object.hasOwn(jsonc.parse(restored), SDK_SETTING), false);
});

test('settings fallback refuses dirty or invalid settings without overwriting the file', async t => {
  for (const text of ['{ "editor.fontSize": 15 }', '{ invalid json }']) {
    const f = await fixture(t, text);
    f.document.isDirty = !text.includes('invalid');
    await assert.rejects(f.setting.write('/sdk/new'), /pending edits|JSON errors/);
    assert.equal(await fs.readFile(f.file, 'utf8'), text);
  }
});

test('settings fallback refuses named profiles, and ordinary API errors do not trigger file edits', async t => {
  const f = await fixture(t, '{}');
  const profileStorage = path.join(
    path.dirname(path.dirname(f.storage)),
    'profiles',
    'named',
    'globalStorage',
    'updater'
  );
  const setting = createSdkSetting(partialMock<VSCode>(f.vscode), profileStorage, SDK_SETTING);
  await assert.rejects(setting.write('/sdk/new'), /default local VS Code profile/);
  f.configuration.update = async () => {
    throw new Error('setting is locked');
  };
  await assert.rejects(f.setting.write('/sdk/new'), /setting is locked/);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{}');
});

test('a higher priority configuration cannot silently override the selected SDK', async t => {
  const f = await fixture(t, '{}');
  f.configuration.update = async () => {};
  await assert.rejects(f.setting.write('/sdk/new'), /higher-priority setting/);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{}');
});
