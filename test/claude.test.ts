import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { EnvironmentAPI } from '../src/providers/claude/binding';
import { createBinding } from '../src/providers/claude/binding';
import { launchAgent } from '../src/providers/claude/launch-agent';
import * as claude from '../src/providers/claude/runtime';
import { switchLink } from '../src/shared/files';
import { temporary, fakeSdk } from './helpers/files';
import { assertPresent } from './helpers/types';

function fixtureBinding(root: string, initial: string | null = null) {
  let env = initial,
    failNext = false;
  const systemAPI: EnvironmentAPI = {
    getEnv: async () => env,
    setEnv: async value => {
      if (failNext) {
        failNext = false;
        throw new Error('launchctl failed');
      }
      env = value;
    },
  };
  const binding = createBinding(path.join(root, 'storage'), {
    home: path.join(root, 'home'),
    platform: 'darwin',
    systemAPI,
  });
  return {
    binding,
    fail: () => {
      failNext = true;
    },
    env: () => env,
  };
}

test('Claude selection persists stable environment path, switches versions, and rolls back', async t => {
  const root = await temporary(t),
    f = fixtureBinding(root, '/original/sdk');
  const first = await fakeSdk(root, 'one'),
    second = await fakeSdk(root, 'two');
  await f.binding.select(first);
  assert.equal(f.env(), f.binding.current);
  assert.equal(await fs.readlink(f.binding.current), first);
  assert.equal(await fs.readFile(f.binding.plist, 'utf8'), launchAgent(f.binding.current));
  await f.binding.select(first);
  assert.equal(
    assertPresent((await f.binding.inspect()).state).history.length,
    1,
    'repeat selection is a no-op'
  );
  await f.binding.select(second);
  assert.equal(f.env(), f.binding.current, 'environment path is stable across upgrades');
  await f.binding.rollback();
  assert.equal(await fs.readlink(f.binding.current), first);
  await f.binding.restore();
  assert.equal(f.env(), '/original/sdk');
  await assert.rejects(fs.lstat(f.binding.current), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(f.binding.plist), { code: 'ENOENT' });
  await f.binding.rollback();
  assert.equal(await fs.readlink(f.binding.current), first, 'restore itself can be rolled back');
});

test('failed environment changes restore the link, login file, and recovery record', async t => {
  const root = await temporary(t),
    f = fixtureBinding(root);
  const first = await fakeSdk(root, 'one'),
    second = await fakeSdk(root, 'two');
  await f.binding.select(first);
  f.fail();
  await assert.rejects(f.binding.select(second), /launchctl failed/);
  assert.equal(await fs.readlink(f.binding.current), first);
  assert.equal(f.env(), f.binding.current);
  assert.equal(assertPresent((await f.binding.inspect()).state).pending, undefined);
  assert.equal(assertPresent((await f.binding.inspect()).state).history.length, 1);
});

test('binding refuses unmanaged content and externally edited login configuration', async t => {
  const root = await temporary(t),
    f = fixtureBinding(root),
    sdk = await fakeSdk(root, 'sdk');
  await fs.mkdir(f.binding.current, { recursive: true });
  await assert.rejects(f.binding.select(sdk), /refusing to replace/);
  await fs.rmdir(f.binding.current);
  await f.binding.select(sdk);
  await fs.writeFile(f.binding.plist, 'user changed this');
  await assert.rejects(f.binding.restore(), /edited outside/);
  assert.equal(await fs.readFile(f.binding.plist, 'utf8'), 'user changed this');
  assert.throws(() => createBinding(root, { platform: 'linux' }), /supports macOS/);
});

test('interrupted selection can recover through pending rollback', async t => {
  const root = await temporary(t),
    f = fixtureBinding(root),
    sdk = await fakeSdk(root, 'sdk');
  await f.binding.select(sdk);
  const state = assertPresent((await f.binding.inspect()).state);
  await fs.writeFile(f.binding.statePath, JSON.stringify({ ...state, pending: state.original }));
  await assert.rejects(f.binding.select(sdk), /interrupted/);
  await f.binding.rollback();
  assert.equal(f.env(), null);
  assert.equal(assertPresent((await f.binding.inspect()).state).pending, undefined);
});

test('LaunchAgent XML escapes paths and link switching refuses ordinary files', async t => {
  const root = await temporary(t),
    file = path.join(root, 'existing');
  assert.match(launchAgent('/example/A & B/<current>'), /A &amp; B\/&lt;current&gt;/);
  await fs.writeFile(file, 'user file');
  await assert.rejects(switchLink(file, '/new'), /refusing to replace/);
  assert.equal(await fs.readFile(file, 'utf8'), 'user file');
});

test('failed recovery keeps the journal available for a later rollback', async t => {
  const root = await temporary(t);
  let env: string | null = null;
  let failures = 0;
  const binding = createBinding(path.join(root, 'storage'), {
    home: path.join(root, 'home'),
    platform: 'darwin',
    systemAPI: {
      getEnv: async () => env,
      setEnv: async value => {
        if (failures > 0) {
          failures--;
          throw new Error('launchctl unavailable');
        }
        env = value;
      },
    },
  });
  const first = await fakeSdk(root, 'one');
  const second = await fakeSdk(root, 'two');
  await binding.select(first);
  const before = await binding.inspect();
  failures = 2;

  await assert.rejects(binding.select(second), /Recovery is pending/);
  assert.deepEqual(assertPresent((await binding.inspect()).state).pending, {
    link: before.link,
    plist: before.plist,
    env: before.env,
  });
  await assert.rejects(binding.select(second), /interrupted/);
  assert.equal(await binding.rollback(), true);
  const recovered = await binding.inspect();
  assert.equal(recovered.link, first);
  assert.equal(recovered.env, before.env);
  assert.equal(recovered.plist, before.plist);
  assert.deepEqual(recovered.state, before.state);
});

test('a successful setenv that is not retained triggers recovery', async t => {
  const root = await temporary(t);
  const binding = createBinding(path.join(root, 'storage'), {
    home: path.join(root, 'home'),
    platform: 'darwin',
    systemAPI: { getEnv: async () => null, setEnv: async () => {} },
  });
  const sdk = await fakeSdk(root, 'sdk');
  await assert.rejects(binding.select(sdk), /not retained/);
  const recovered = await binding.inspect();
  assert.equal(recovered.link, null);
  assert.equal(recovered.plist, null);
  assert.equal(assertPresent(recovered.state).pending, undefined);
  assert.deepEqual(assertPresent(recovered.state).history, []);
});

test('Claude selects the matching native package and never publishes a failed handshake', async t => {
  const root = await temporary(t),
    host = claude.target('darwin', 'arm64');
  const name = `${claude.PACKAGE}-${host.id}`;
  const release = {
    name: claude.PACKAGE,
    version: '0.3.289',
    claudeCodeVersion: '2.1.289',
    optionalDependencies: { [name]: '0.3.289' },
    dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: 'sdk' },
  };
  const deps: claude.InstallDependencies = {
    host,
    metadata: async (pkg, version = 'latest') => {
      assert.equal(pkg, name);
      return {
        name: pkg,
        version,
        dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: 'native' },
      };
    },
    unpack: async (_dist, dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    healthCheck: async () => {
      throw new Error('bad handshake');
    },
  };
  await assert.rejects(
    claude.install(root, release, () => {}, deps),
    /bad handshake/
  );
  assert.deepEqual(await fs.readdir(root), []);
  deps.healthCheck = async () => {};
  const installed = await claude.install(root, release, () => {}, deps);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(installed, 'installation.json'), 'utf8'))
      .claudeCodeVersion,
    '2.1.289'
  );
  assert.equal(claude.target('linux', 'arm64', true).id, 'linux-arm64-musl');
  assert.equal(claude.target('linux', 'x64', false).id, 'linux-x64');
});

test('Claude rejects a manually replaced native binary even if the SDK version looks correct', async t => {
  const root = await temporary(t),
    host = claude.target('darwin', 'arm64');
  const sdk = path.join(root, 'node_modules', claude.PACKAGE),
    native = path.join(root, 'node_modules', `${claude.PACKAGE}-${host.id}`);
  await fs.mkdir(sdk, { recursive: true });
  await fs.mkdir(native, { recursive: true });
  await fs.writeFile(
    path.join(sdk, 'package.json'),
    JSON.stringify({ name: claude.PACKAGE, version: '0.3.289', claudeCodeVersion: '2.1.289' })
  );
  await fs.writeFile(
    path.join(native, 'package.json'),
    JSON.stringify({ name: `${claude.PACKAGE}-${host.id}`, version: '0.3.289' })
  );
  await fs.writeFile(path.join(native, 'claude'), '#!/bin/sh\necho "2.1.258 (Claude Code)"\n', {
    mode: 0o755,
  });
  await assert.rejects(claude.healthCheck(root, '0.3.289', host), /mismatch/);
});

test('Claude health check runs the compiled probe, imports an ESM SDK, and cleans up its temporary home', async t => {
  const root = await temporary(t);
  const host = claude.target('darwin', 'arm64');
  const sdk = path.join(root, 'node_modules', claude.PACKAGE);
  const native = path.join(root, 'node_modules', `${claude.PACKAGE}-${host.id}`);
  await fs.mkdir(sdk, { recursive: true });
  await fs.mkdir(native, { recursive: true });
  await fs.writeFile(
    path.join(sdk, 'package.json'),
    JSON.stringify({
      name: claude.PACKAGE,
      version: '0.3.289',
      claudeCodeVersion: '2.1.289',
    })
  );
  await fs.writeFile(
    path.join(native, 'package.json'),
    JSON.stringify({
      name: `${claude.PACKAGE}-${host.id}`,
      version: '0.3.289',
    })
  );
  await fs.writeFile(path.join(native, 'claude'), '#!/bin/sh\necho "2.1.289 (Claude Code)"\n', {
    mode: 0o755,
  });
  await fs.writeFile(
    path.join(sdk, 'sdk.mjs'),
    `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
export function query() {}
export const listSessions = query, getSessionMessages = query, getSessionInfo = query,
  listSubagents = query, getSubagentMessages = query, deleteSession = query,
  forkSession = query, createSdkMcpServer = query, tool = query;
export async function startup({ options }) {
  assert.equal(options.persistSession, false);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, options.cwd);
  await fs.writeFile(new URL('probe-home.txt', import.meta.url), options.cwd);
  return { close() { console.log('closed'); } };
}
`
  );
  const found = await claude.healthCheck(root, '0.3.289', host);
  assert.equal(found.sdk, '0.3.289');
  const probeHome = await fs.readFile(path.join(sdk, 'probe-home.txt'), 'utf8');
  await assert.rejects(fs.access(probeHome), { code: 'ENOENT' });
});
