import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { withLock } from '../src/shared/files';
import { registryURL, validateArchiveNames, verifyFile } from '../src/shared/registry';
import { stableVersion, compareVersions } from '../src/shared/versions';
import { userDataFromStorage } from '../src/vscode/storage';
import { temporary } from './helpers/files';

test('stable versions compare numerically and reject tags/path injection', () => {
  assert.equal(compareVersions('0.160.0', '0.99.0'), 1);
  assert.equal(compareVersions('0.160.0', '0.160.0'), 0);
  for (const value of ['latest', '0.160.0-alpha.1', '../escape', null])
    assert.throws(() => stableVersion(value));
});

test('package downloads reject other origins, embedded credentials and traversal entries', () => {
  for (const url of [
    'http://registry.npmjs.org/a',
    'https://evil.invalid/a',
    'https://user@registry.npmjs.org/a',
  ]) {
    assert.throws(() => registryURL(url));
  }
  validateArchiveNames('package/\npackage/vendor/codex\n');
  for (const list of ['package/../../escape', '/tmp/file', 'package/a\\b', 'not-package/foo']) {
    assert.throws(() => validateArchiveNames(list));
  }
});

test('checksum verification accepts valid bytes and rejects corrupt downloads', async t => {
  const root = await temporary(t),
    file = path.join(root, 'package.tgz');
  await fs.writeFile(file, 'original bytes');
  const integrity = `sha512-${crypto.createHash('sha512').update('original bytes').digest('base64')}`;
  await verifyFile(file, integrity);
  await fs.writeFile(file, 'corrupt bytes');
  await assert.rejects(verifyFile(file, integrity), /checksum mismatch/);
  await assert.rejects(verifyFile(file, 'sha1-abc'), /SHA-512/);
});

test('concurrent installs are rejected without disturbing the first lock', async t => {
  const root = await temporary(t);
  await withLock(root, async () => {
    await assert.rejects(
      withLock(root, async () => {}),
      /Another update/
    );
    await fs.access(path.join(root, '.install-lock'));
  });
  assert.deepEqual(await fs.readdir(root), []);
});

test('storage discovery handles default, portable and named profile paths', () => {
  for (const folder of [
    '/custom/Code/User/globalStorage/id',
    '/custom/Code/User/profiles/abc/globalStorage/id',
  ]) {
    assert.equal(userDataFromStorage(folder), '/custom/Code');
  }
  assert.throws(() => userDataFromStorage('/tmp/random'), /Cannot locate/);
});
