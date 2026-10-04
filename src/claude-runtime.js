'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const shared = require('./runtime');

const PACKAGE = '@anthropic-ai/claude-agent-sdk';
const ENV = 'VSCODE_AGENT_HOST_CLAUDE_SDK_ROOT';

function target(platform = process.platform, arch = process.arch, musl = platform === 'linux' && !process.report?.getReport().header.glibcVersionRuntime) {
  shared.target(platform, arch); // Reject unsupported hosts before constructing paths.
  return { id: `${platform}-${arch}${musl ? '-musl' : ''}` };
}
const packageDir = root => path.join(root, 'node_modules', PACKAGE);
const binaryPath = (root, host = target()) => path.join(root, 'node_modules', `${PACKAGE}-${host.id}`, 'claude');
const metadata = (version = 'latest') => shared.packageMetadata(PACKAGE, version);

async function versions(root, host = target()) {
  const sdk = JSON.parse(await fs.readFile(path.join(packageDir(root), 'package.json'), 'utf8'));
  const native = JSON.parse(await fs.readFile(path.join(root, 'node_modules', `${PACKAGE}-${host.id}`, 'package.json'), 'utf8'));
  if (sdk.name !== PACKAGE || native.name !== `${PACKAGE}-${host.id}`) throw new Error('Unexpected Claude package identity.');
  const { stdout } = await exec(binaryPath(root, host), ['--version'], { timeout: 15_000 });
  const match = stdout.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
  if (!match) throw new Error(`Unexpected Claude binary version: ${stdout.trim()}`);
  return { sdk: shared.stableVersion(sdk.version), native: native.version, binary: match[1], expectedBinary: sdk.claudeCodeVersion };
}

async function healthCheck(root, expectedVersion, host = target()) {
  const found = await versions(root, host);
  if (found.sdk !== expectedVersion || found.native !== expectedVersion || found.binary !== found.expectedBinary) {
    throw new Error(`Claude SDK/binary mismatch: SDK ${found.sdk}, native package ${found.native}, binary ${found.binary}, expected ${found.expectedBinary}.`);
  }
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-updater-health-'));
  try {
    const { stdout } = await exec(process.execPath, [path.join(__dirname, 'claude-probe.cjs'), root, temporaryHome], {
      timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: temporaryHome,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' },
    });
    if (!stdout.split('\n').some(line => line === '{"initialized":true}')) throw new Error('Claude SDK handshake did not complete.');
    return found;
  } finally { await fs.rm(temporaryHome, { recursive: true, force: true }); }
}

async function install(storage, release, log = () => {}, deps = {}) {
  const host = deps.host || target(), version = shared.stableVersion(release.version);
  const extract = deps.unpack || shared.unpack;
  const check = deps.healthCheck || healthCheck;
  const getMetadata = deps.metadata || shared.packageMetadata;
  return shared.withLock(storage, async () => {
    const finalRoot = path.join(storage, 'versions', version, host.id);
    try {
      await fs.access(finalRoot);
      await check(finalRoot, version, host);
      return finalRoot;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const nativeName = `${PACKAGE}-${host.id}`;
    if (release.name !== PACKAGE || release.optionalDependencies?.[nativeName] !== version || !release.claudeCodeVersion) {
      throw new Error('Anthropic package layout changed; updater needs an update.');
    }
    const native = await getMetadata(nativeName, version);
    if (native.name !== nativeName || native.version !== version) throw new Error('Unexpected Anthropic native package.');
    const staging = await fs.mkdtemp(path.join(storage, '.staging-'));
    try {
      log(`Downloading Claude Agent SDK ${version} / Claude Code ${release.claudeCodeVersion}; verifying SHA-512 checksums…`);
      await extract(release.dist, packageDir(staging), path.join(staging, 'sdk.tgz'));
      await extract(native.dist, path.join(staging, 'node_modules', nativeName), path.join(staging, 'native.tgz'));
      log('Checking SDK import, matching binary, and startup handshake without a prompt…');
      await check(staging, version, host);
      await fs.writeFile(path.join(staging, 'installation.json'), JSON.stringify({ version, claudeCodeVersion: release.claudeCodeVersion, target: host.id, installedAt: new Date().toISOString(), integrity: { sdk: release.dist.integrity, native: native.dist.integrity } }, null, 2));
      await fs.mkdir(path.dirname(finalRoot), { recursive: true });
      await fs.rename(staging, finalRoot);
      return finalRoot;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  });
}

async function inspectRuntime(appRoot, extensionStorage, selectedRoot) {
  const product = JSON.parse(await fs.readFile(path.join(appRoot, 'product.json'), 'utf8'));
  const bundled = product.agentSdks?.claude?.version;
  if (!bundled) throw new Error('This VS Code build does not advertise a Claude SDK.');
  shared.stableVersion(bundled);
  const host = target();
  const cacheRoot = path.join(shared.userDataFromStorage(extensionStorage), 'agent-host/sdk-cache/claude', bundled, host.id);
  const root = selectedRoot || cacheRoot;
  let installed, error;
  try { installed = await versions(root, host); } catch (e) { error = e.message; }
  return { root, version: installed?.sdk, binary: installed?.binary, installed, error, bundled, cacheRoot, vscodeVersion: product.version, host };
}

module.exports = { PACKAGE, ENV, target, metadata, versions, binaryPath, healthCheck, install, inspectRuntime };
