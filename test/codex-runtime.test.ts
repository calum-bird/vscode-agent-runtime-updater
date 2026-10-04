import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import * as runtime from '../src/providers/codex/runtime';
import type { PackageMetadata } from '../src/shared/types';
import { temporary } from './helpers/files';
import { assertPresent } from './helpers/types';

const host = runtime.target('darwin', 'arm64');
const release: PackageMetadata = {
  name: '@openai/codex',
  version: '0.160.0',
  dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: 'cli' },
  optionalDependencies: { '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.160.0-darwin-arm64' },
};
function dependencies(overrides: runtime.InstallDependencies = {}): runtime.InstallDependencies {
  return {
    host,
    metadata: async () => ({
      name: '@openai/codex',
      version: '0.160.0-darwin-arm64',
      dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: 'native' },
    }),
    unpack: async (_dist, directory) => {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'fixture'), 'ok');
    },
    healthCheck: async () => {},
    ...overrides,
  };
}

test('install publishes only after health check; an installed version is reused', async t => {
  const root = await temporary(t);
  let checks = 0,
    extractions = 0;
  const deps = dependencies({
    unpack: async (...args) => {
      extractions++;
      await assertPresent(dependencies().unpack)(...args);
    },
    healthCheck: async () => {
      checks++;
    },
  });
  const selected = await runtime.install(root, release, () => {}, deps);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(selected, 'installation.json'), 'utf8')).version,
    '0.160.0'
  );
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
    await assert.rejects(
      runtime.install(
        root,
        release,
        () => {},
        dependencies({
          [failure]: async () => {
            throw new Error('simulated failure');
          },
        })
      ),
      /simulated failure/
    );
    assert.equal(await fs.readFile(path.join(root, 'previous', 'binary'), 'utf8'), 'working');
    assert.deepEqual(await fs.readdir(root), ['previous']);
  }
});

test('changed registry package layout fails before extraction', async t => {
  const root = await temporary(t);
  await assert.rejects(
    runtime.install(root, { ...release, optionalDependencies: {} }, () => {}, dependencies()),
    /layout changed/
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test('SDK inspection reads the actual binary rather than trusting the cache directory label', async t => {
  const root = await temporary(t),
    app = path.join(root, 'app'),
    storage = path.join(root, 'Code/User/globalStorage/id');
  await fs.mkdir(app);
  await fs.writeFile(
    path.join(app, 'product.json'),
    JSON.stringify({ version: '1.140.0', agentSdks: { codex: { version: '0.153.0' } } })
  );
  const cache = path.join(root, 'Code/agent-host/sdk-cache/codex/0.153.0', runtime.target().id);
  const binary = runtime.binaryPath(cache);
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
  const result = await runtime.inspectRuntime(app, storage);
  assert.equal(result.bundled, '0.153.0');
  assert.equal(result.version, '0.160.0');
});

test('app-server probe handles initialization, paginated models, errors and timeouts', async t => {
  const root = await temporary(t),
    binary = path.join(root, 'fake-codex');
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nconst readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); let result;
  if(m.method==='initialize') result={userAgent:'fixture',codexHome:'/tmp/test'};
  if(m.method==='model/list') result={data:[{model:m.params.cursor?'gpt-6.1-sol':'gpt-6-sol'}],nextCursor:m.params.cursor?null:'next'};
  if(result) console.log(JSON.stringify({id:m.id,result}));
});\n`,
    { mode: 0o755 }
  );
  const result = await runtime.probe(binary, { models: true });
  assert.deepEqual(
    result.models.map(m => m.model),
    ['gpt-6-sol', 'gpt-6.1-sol']
  );
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdin.on('data',()=>console.log(JSON.stringify({id:1,error:{message:'broken'}})));\n`
  );
  await assert.rejects(runtime.probe(binary), /broken/);
  await fs.writeFile(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
  await assert.rejects(runtime.probe(binary, { timeoutMs: 100 }), /timed out/);
  await assert.rejects(runtime.probe(path.join(root, 'missing')), /ENOENT/);
});
