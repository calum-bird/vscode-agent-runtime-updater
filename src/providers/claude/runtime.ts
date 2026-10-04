import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../../shared/errors';
import { readJson, withTemporaryDirectory } from '../../shared/files';
import type { InstallationDependencies } from '../../shared/installation';
import { installVerified } from '../../shared/installation';
import { target as supportedTarget, usesMusl } from '../../shared/platform';
import { exec } from '../../shared/process';
import { packageMetadata, unpack } from '../../shared/registry';
import type { Host, Logger, PackageMetadata } from '../../shared/types';
import { stableVersion } from '../../shared/versions';
import { bundledRuntime } from '../../vscode/storage';
import { PACKAGE, ENV } from './constants';

export interface InstallDependencies extends InstallationDependencies<Host> {
  metadata?: typeof packageMetadata;
}

function target(
  platform: string = process.platform,
  arch: string = process.arch,
  musl = usesMusl(platform)
) {
  supportedTarget(platform, arch);
  return { id: `${platform}-${arch}${musl ? '-musl' : ''}` };
}

function packageDir(root: string) {
  return path.join(root, 'node_modules', PACKAGE);
}

function binaryPath(root: string, host: Host = target()) {
  return path.join(root, 'node_modules', `${PACKAGE}-${host.id}`, 'claude');
}

function metadata(version = 'latest') {
  return packageMetadata(PACKAGE, version);
}

async function versions(root: string, host: Host = target()) {
  const nativeName = `${PACKAGE}-${host.id}`;
  const sdk = await readJson<PackageMetadata>(path.join(packageDir(root), 'package.json'));
  const native = await readJson<PackageMetadata>(
    path.join(root, 'node_modules', nativeName, 'package.json')
  );
  if (sdk.name !== PACKAGE || native.name !== nativeName) {
    throw new Error('Unexpected Claude package identity.');
  }
  const { stdout } = await exec(binaryPath(root, host), ['--version'], { timeout: 15_000 });
  const match = stdout.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
  if (!match) throw new Error(`Unexpected Claude binary version: ${stdout.trim()}`);
  return {
    sdk: stableVersion(sdk.version),
    native: native.version,
    binary: match[1],
    expectedBinary: sdk.claudeCodeVersion,
  };
}

async function healthCheck(root: string, expectedVersion: string, host: Host = target()) {
  const found = await versions(root, host);
  if (
    found.sdk !== expectedVersion ||
    found.native !== expectedVersion ||
    found.binary !== found.expectedBinary
  ) {
    throw new Error(
      `Claude SDK/binary mismatch: SDK ${found.sdk}, native package ${found.native}, binary ${found.binary}, expected ${found.expectedBinary}.`
    );
  }

  return withTemporaryDirectory(os.tmpdir(), 'claude-updater-health-', async temporaryHome => {
    const { stdout } = await exec(
      process.execPath,
      [path.join(__dirname, 'probe.js'), root, temporaryHome],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          CLAUDE_CONFIG_DIR: temporaryHome,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
        },
      }
    );
    if (!stdout.split('\n').some(line => line === '{"initialized":true}')) {
      throw new Error('Claude SDK handshake did not complete.');
    }
    return found;
  });
}

async function install(
  storage: string,
  release: PackageMetadata,
  log: Logger = () => {},
  deps: InstallDependencies = {}
) {
  const host = deps.host || target();
  const version = stableVersion(release.version);
  const extract = deps.unpack || unpack;
  const getMetadata = deps.metadata || packageMetadata;

  return installVerified(storage, {
    version,
    host,
    healthCheck: deps.healthCheck || healthCheck,
    async stage(staging) {
      const nativeName = `${PACKAGE}-${host.id}`;
      if (
        release.name !== PACKAGE ||
        release.optionalDependencies?.[nativeName] !== version ||
        !release.claudeCodeVersion
      ) {
        throw new Error('Anthropic package layout changed; updater needs an update.');
      }
      const native = await getMetadata(nativeName, version);
      if (native.name !== nativeName || native.version !== version) {
        throw new Error('Unexpected Anthropic native package.');
      }

      log(
        `Downloading Claude Agent SDK ${version} / Claude Code ${release.claudeCodeVersion}; verifying SHA-512 checksums…`
      );
      await extract(release.dist, packageDir(staging), path.join(staging, 'sdk.tgz'));
      await extract(
        native.dist,
        path.join(staging, 'node_modules', nativeName),
        path.join(staging, 'native.tgz')
      );
      log('Checking SDK import, matching binary, and startup handshake without a prompt…');
      return {
        claudeCodeVersion: release.claudeCodeVersion,
        integrity: { sdk: release.dist.integrity, native: native.dist.integrity },
      };
    },
  });
}

async function inspectRuntime(
  appRoot: string,
  extensionStorage: string,
  selectedRoot?: string | null
) {
  const host = target();
  const bundled = await bundledRuntime(appRoot, extensionStorage, 'claude', host);
  const root = selectedRoot || bundled.cacheRoot;
  let installed;
  let error;
  try {
    installed = await versions(root, host);
  } catch (failure) {
    error = errorMessage(failure);
  }
  return { ...bundled, root, version: installed?.sdk, binary: installed?.binary, installed, error };
}

export {
  PACKAGE,
  ENV,
  target,
  metadata,
  versions,
  binaryPath,
  healthCheck,
  install,
  inspectRuntime,
};
