'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('../src/runtime');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-updater-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const host = runtime.target('darwin', 'arm64');
const release = {
  version: '0.160.0', dist: { integrity: 'cli' },
  optionalDependencies: { '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.160.0-darwin-arm64' },
};
function dependencies(overrides = {}) {
  return {
    host,
    metadata: async () => ({ version: '0.160.0-darwin-arm64', dist: { integrity: 'native' } }),
    unpack: async (_dist, directory) => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'fixture'), 'ok'); },
    healthCheck: async () => {},
    ...overrides,
  };
}

test('stable versions compare numerically and reject tags/path injection', () => {
  assert.equal(runtime.compareVersions('0.160.0', '0.99.0'), 1);
  assert.equal(runtime.compareVersions('0.160.0', '0.160.0'), 0);
  for (const value of ['latest', '0.160.0-alpha.1', '../escape', null]) assert.throws(() => runtime.stableVersion(value));
});

test('package downloads reject other origins, embedded credentials and traversal entries', () => {
  for (const url of ['http://registry.npmjs.org/a', 'https://evil.invalid/a', 'https://user@registry.npmjs.org/a']) {
    assert.throws(() => runtime.registryURL(url));
  }
  runtime.validateArchiveNames('package/\npackage/vendor/codex\n');
  for (const list of ['package/../../escape', '/tmp/file', 'package/a\\b', 'not-package/foo']) {
    assert.throws(() => runtime.validateArchiveNames(list));
  }
});

test('checksum verification accepts valid bytes and rejects corrupt downloads', async t => {
  const root = await temporary(t), file = path.join(root, 'package.tgz');
  await fs.writeFile(file, 'original bytes');
  const integrity = `sha512-${crypto.createHash('sha512').update('original bytes').digest('base64')}`;
  await runtime.verifyFile(file, integrity);
  await fs.writeFile(file, 'corrupt bytes');
  await assert.rejects(runtime.verifyFile(file, integrity), /checksum mismatch/);
  await assert.rejects(runtime.verifyFile(file, 'sha1-abc'), /SHA-512/);
});

test('install publishes only after health check; an installed version is reused', async t => {
  const root = await temporary(t);
  let checks = 0, extractions = 0;
  const deps = dependencies({
    unpack: async (...args) => { extractions++; await dependencies().unpack(...args); },
    healthCheck: async () => { checks++; },
  });
  const selected = await runtime.install(root, release, () => {}, deps);
  assert.equal(JSON.parse(await fs.readFile(path.join(selected, 'installation.json'))).version, '0.160.0');
  assert.equal(await runtime.install(root, release, () => {}, deps), selected);
  assert.equal(extractions, 2);
  assert.equal(checks, 2);
  assert.deepEqual(await fs.readdir(root), ['versions']);
});

test('failed download or handshake leaves previous runtime intact and releases lock', async t => {
  for (const failure of ['unpack', 'healthCheck']) {
    const root = await temporary(t);
    await fs.mkdir(path.join(root, 'previous'));
    await fs.writeFile(path.join(root, 'previous', 'binary'), 'working');
    await assert.rejects(runtime.install(root, release, () => {}, dependencies({ [failure]: async () => { throw new Error('simulated failure'); } })), /simulated failure/);
    assert.equal(await fs.readFile(path.join(root, 'previous', 'binary'), 'utf8'), 'working');
    assert.deepEqual(await fs.readdir(root), ['previous']);
  }
});

test('concurrent installs are rejected without disturbing the first lock', async t => {
  const root = await temporary(t);
  await runtime.withLock(root, async () => {
    await assert.rejects(runtime.withLock(root, async () => {}), /Another update/);
    await fs.access(path.join(root, '.install-lock'));
  });
  assert.deepEqual(await fs.readdir(root), []);
});

test('changed registry package layout fails before extraction', async t => {
  const root = await temporary(t);
  await assert.rejects(runtime.install(root, { ...release, optionalDependencies: {} }, () => {}, dependencies()), /layout changed/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('storage discovery handles default, portable and named profile paths', () => {
  for (const folder of ['/custom/Code/User/globalStorage/id', '/custom/Code/User/profiles/abc/globalStorage/id']) {
    assert.equal(runtime.userDataFromStorage(folder), '/custom/Code');
  }
  assert.throws(() => runtime.userDataFromStorage('/tmp/random'), /Cannot locate/);
});

test('SDK inspection reads the actual binary rather than trusting the cache directory label', async t => {
  const root = await temporary(t), app = path.join(root, 'app'), storage = path.join(root, 'Code/User/globalStorage/id');
  await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'product.json'), JSON.stringify({ version: '1.140.0', agentSdks: { codex: { version: '0.153.0' } } }));
  const cache = path.join(root, 'Code/agent-host/sdk-cache/codex/0.153.0', runtime.target().id);
  const binary = runtime.binaryPath(cache);
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
  const result = await runtime.inspectRuntime(app, storage);
  assert.equal(result.bundled, '0.153.0');
  assert.equal(result.version, '0.160.0');
});

test('app-server probe handles initialization, paginated models, errors and timeouts', async t => {
  const root = await temporary(t), binary = path.join(root, 'fake-codex');
  await fs.writeFile(binary, `#!${process.execPath}\nconst readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); let result;
  if(m.method==='initialize') result={userAgent:'fixture',codexHome:'/tmp/test'};
  if(m.method==='model/list') result={data:[{model:m.params.cursor?'gpt-6.1-sol':'gpt-6-sol'}],nextCursor:m.params.cursor?null:'next'};
  if(result) console.log(JSON.stringify({id:m.id,result}));
});\n`, { mode: 0o755 });
  const result = await runtime.probe(binary, { models: true });
  assert.deepEqual(result.models.map(m => m.model), ['gpt-6-sol', 'gpt-6.1-sol']);
  await fs.writeFile(binary, `#!${process.execPath}\nprocess.stdin.on('data',()=>console.log(JSON.stringify({id:1,error:{message:'broken'}})));\n`);
  await assert.rejects(runtime.probe(binary), /broken/);
  await fs.writeFile(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
  await assert.rejects(runtime.probe(binary, { timeoutMs: 100 }), /timed out/);
  await assert.rejects(runtime.probe(path.join(root, 'missing')), /ENOENT/);
});
