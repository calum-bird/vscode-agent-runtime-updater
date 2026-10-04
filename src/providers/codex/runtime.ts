import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../../shared/errors';
import { withTemporaryDirectory } from '../../shared/files';
import type { InstallationDependencies } from '../../shared/installation';
import { installVerified } from '../../shared/installation';
import { target } from '../../shared/platform';
import { exec } from '../../shared/process';
import { packageMetadata, unpack } from '../../shared/registry';
import type { CodexHost, Logger, PackageMetadata } from '../../shared/types';
import { stableVersion } from '../../shared/versions';
import { bundledRuntime } from '../../vscode/storage';
import { PACKAGE } from './constants';
import { probe } from './probe';

export interface InstallDependencies extends InstallationDependencies<CodexHost> {
  metadata?: typeof metadata;
}

function metadata(version = 'latest') {
  return packageMetadata(PACKAGE, version);
}

function binaryPath(root: string, host: CodexHost = target()) {
  return path.join(
    root,
    'node_modules',
    `${PACKAGE}-${host.id}`,
    'vendor',
    host.triple,
    'bin',
    'codex'
  );
}

async function binaryVersion(root: string, host: CodexHost = target()) {
  const { stdout } = await exec(binaryPath(root, host), ['--version'], { timeout: 15_000 });
  const match = stdout.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Unexpected Codex version: ${stdout.trim()}`);
  return match[1];
}

async function healthCheck(root: string, version: string, host: CodexHost = target()) {
  if ((await binaryVersion(root, host)) !== version) {
    throw new Error('Installed binary does not match requested version.');
  }
  await withTemporaryDirectory(os.tmpdir(), 'codex-updater-health-', codexHome =>
    probe(binaryPath(root, host), { codexHome })
  );
}

async function install(
  storage: string,
  release: PackageMetadata,
  log: Logger = () => {},
  deps: InstallDependencies = {}
) {
  const host = deps.host || target();
  const version = stableVersion(release.version);
  const getMetadata = deps.metadata || metadata;
  const extract = deps.unpack || unpack;

  return installVerified(storage, {
    version,
    host,
    healthCheck: deps.healthCheck || healthCheck,
    async stage(staging) {
      const nativeName = `${PACKAGE}-${host.id}`;
      const nativeVersion = `${version}-${host.id}`;
      const expectedAlias = `npm:${PACKAGE}@${nativeVersion}`;
      if (release.optionalDependencies?.[nativeName] !== expectedAlias) {
        throw new Error('Codex package layout changed; updater needs an update.');
      }
      const native = await getMetadata(nativeVersion);
      if (native.version !== nativeVersion) throw new Error('Unexpected native package version.');

      log(`Downloading Codex ${version} (${host.id}); verifying npm SHA-512 checksums…`);
      await extract(
        release.dist,
        path.join(staging, 'node_modules', PACKAGE),
        path.join(staging, 'cli.tgz')
      );
      await extract(
        native.dist,
        path.join(staging, 'node_modules', nativeName),
        path.join(staging, 'native.tgz')
      );
      log('Checking binary version and app-server initialization…');
      return { integrity: { cli: release.dist.integrity, native: native.dist.integrity } };
    },
  });
}

async function inspectRuntime(appRoot: string, storage: string, configuredRoot?: string) {
  const host = target();
  const bundled = await bundledRuntime(appRoot, storage, 'codex', host);
  const root = configuredRoot || bundled.cacheRoot;
  let version;
  let error;
  try {
    version = await binaryVersion(root, host);
  } catch (failure) {
    error = errorMessage(failure);
  }
  return { ...bundled, root, version, error };
}

export { target, metadata, binaryPath, binaryVersion, probe, healthCheck, install, inspectRuntime };
