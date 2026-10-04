'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { createWriteStream, createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const readline = require('node:readline');

const exec = promisify(execFile);
const SDK_SETTING = 'chat.agentHost.codexAgent.sdkRoot';
const REGISTRY = 'https://registry.npmjs.org';

function target(platform = process.platform, arch = process.arch) {
  const id = `${platform}-${arch}`;
  const triple = {
    'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
  }[id];
  if (!triple) throw new Error(`Unsupported host ${id}. This extension supports macOS and Linux x64/arm64.`);
  return { id, triple };
}

function stableVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Expected a stable Codex version, received ${String(value)}.`);
  }
  return value;
}

function compareVersions(a, b) {
  const left = stableVersion(a).split('.').map(Number);
  const right = stableVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

function registryURL(value) {
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password) {
    throw new Error('Package downloads must come from https://registry.npmjs.org.');
  }
  return url;
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(registryURL(url), {
      headers: { 'User-Agent': 'vscode-codex-agent-updater/0.1.0', Accept: 'application/json' },
    }, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(new Error('Invalid registry redirect.'));
        Promise.resolve().then(() => request(new URL(response.headers.location, url), redirects + 1)).then(resolve, reject);
      } else if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`npm registry returned HTTP ${response.statusCode}.`));
      } else resolve(response);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('npm registry request timed out.')));
    req.on('error', reject);
  });
}

async function metadata(version = 'latest') {
  return packageMetadata('@openai/codex', version);
}

async function packageMetadata(name, version = 'latest') {
  const response = await request(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
  let text = '';
  for await (const chunk of response) {
    text += chunk;
    if (text.length > 2 * 1024 * 1024) { response.destroy(); throw new Error('Registry response too large.'); }
  }
  const result = JSON.parse(text);
  if (result.name !== name || !result.dist) throw new Error('Unexpected package metadata.');
  return result;
}

function integrityHash(integrity) {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error('Package is missing a valid SHA-512 integrity checksum.');
  }
  return integrity.slice(7);
}

async function verifyFile(file, integrity) {
  const expected = integrityHash(integrity);
  const hash = crypto.createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('base64') !== expected) throw new Error('Package checksum mismatch; installation was not changed.');
}

async function download(dist, file) {
  integrityHash(dist.integrity);
  const response = await request(dist.tarball);
  let bytes = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 512 * 1024 * 1024 ? new Error('Package exceeds 512 MiB download limit.') : null, chunk);
  } });
  await pipeline(response, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  await verifyFile(file, dist.integrity);
}

function validateArchiveNames(list) {
  const names = list.trim().split('\n');
  if (!names.length || names.some(name => !name.startsWith('package/') || name.includes('\\') || name.split('/').includes('..'))) {
    throw new Error('Unexpected path in package archive.');
  }
}

async function unpack(dist, directory, archive) {
  await download(dist, archive);
  const { stdout } = await exec('tar', ['-tzf', archive], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  validateArchiveNames(stdout);
  // Reject links before extraction so archive entries cannot write outside staging.
  const listing = await exec('tar', ['-tvzf', archive], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (listing.stdout.trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) {
    throw new Error('Package archive contains a link or special file.');
  }
  await fs.mkdir(directory, { recursive: true });
  await exec('tar', ['-xzf', archive, '--strip-components=1', '-C', directory], { timeout: 120_000 });
  await fs.rm(archive);
}

function binaryPath(root, host = target()) {
  return path.join(root, 'node_modules', `@openai/codex-${host.id}`, 'vendor', host.triple, 'bin', 'codex');
}

async function binaryVersion(root, host = target()) {
  const { stdout } = await exec(binaryPath(root, host), ['--version'], { timeout: 15_000 });
  const match = stdout.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/);
  if (!match) throw new Error(`Unexpected Codex version: ${stdout.trim()}`);
  return match[1];
}

async function probe(binary, { codexHome, models = false, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false, result, nextId = 2;
    const foundModels = [], cursors = new Set();
    const timer = setTimeout(() => finish(new Error('Codex app-server health check timed out.')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
      child.once('close', () => {
        clearTimeout(killTimer);
        error ? reject(error) : resolve(value);
      });
    };
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', (code, signal) => finish(new Error(`Codex app-server exited early (${signal || code}).`)));
    child.stderr.resume(); // Drain stderr without logging account/configuration details.
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.error) return finish(new Error(`Codex health check: ${message.error.message}`));
      if (message.id === 1) {
        result = message.result;
        if (!result || typeof result.userAgent !== 'string' || typeof result.codexHome !== 'string') {
          return finish(new Error('Codex initialize response is incompatible with this VS Code integration.'));
        }
        send({ method: 'initialized' });
        if (!models) return finish(null, result);
        send({ id: nextId, method: 'model/list', params: { limit: 100, includeHidden: false } });
      } else if (models && message.id === nextId) {
        if (!Array.isArray(message.result?.data)) return finish(new Error('Invalid Codex model/list response.'));
        foundModels.push(...message.result.data);
        const cursor = message.result.nextCursor;
        if (cursor) {
          if (cursors.has(cursor) || cursors.size > 50) return finish(new Error('Invalid model pagination.'));
          cursors.add(cursor);
          send({ id: ++nextId, method: 'model/list', params: { cursor, limit: 100, includeHidden: false } });
        } else finish(null, { ...result, models: foundModels });
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'codex_agent_updater', title: 'Codex Agent Updater', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    } });
  });
}

async function healthCheck(root, version, host = target()) {
  if (await binaryVersion(root, host) !== version) throw new Error('Installed binary does not match requested version.');
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-updater-health-'));
  try { await probe(binaryPath(root, host), { codexHome: temporaryHome }); }
  finally { await fs.rm(temporaryHome, { recursive: true, force: true }); }
}

async function withLock(storage, action) {
  await fs.mkdir(storage, { recursive: true });
  const lock = path.join(storage, '.install-lock');
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another update is running, or was interrupted. Close other update windows; if none are running, remove ${lock}.`);
    throw error;
  }
  try { return await action(); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}

async function install(storage, release, log = () => {}, deps = {}) {
  const host = deps.host || target();
  const version = stableVersion(release.version);
  const getMetadata = deps.metadata || metadata;
  const extract = deps.unpack || unpack;
  const check = deps.healthCheck || healthCheck;
  return withLock(storage, async () => {
    const finalRoot = path.join(storage, 'versions', version, host.id);
    try {
      await fs.access(finalRoot);
      await check(finalRoot, version, host);
      return finalRoot;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const alias = release.optionalDependencies?.[`@openai/codex-${host.id}`];
    const nativeVersion = `${version}-${host.id}`;
    if (alias !== `npm:@openai/codex@${nativeVersion}`) throw new Error('Codex package layout changed; updater needs an update.');
    const native = await getMetadata(nativeVersion);
    if (native.version !== nativeVersion) throw new Error('Unexpected native package version.');
    const staging = await fs.mkdtemp(path.join(storage, '.staging-'));
    try {
      log(`Downloading Codex ${version} (${host.id}); verifying npm SHA-512 checksums…`);
      await extract(release.dist, path.join(staging, 'node_modules/@openai/codex'), path.join(staging, 'cli.tgz'));
      await extract(native.dist, path.join(staging, 'node_modules', `@openai/codex-${host.id}`), path.join(staging, 'native.tgz'));
      log('Checking binary version and app-server initialization…');
      await check(staging, version, host);
      await fs.writeFile(path.join(staging, 'installation.json'), JSON.stringify({ version, target: host.id, installedAt: new Date().toISOString(), integrity: { cli: release.dist.integrity, native: native.dist.integrity } }, null, 2));
      await fs.mkdir(path.dirname(finalRoot), { recursive: true });
      await fs.rename(staging, finalRoot);
      return finalRoot;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  });
}

function userDataFromStorage(storage) {
  // Default and named profiles both keep extension storage under User/.
  let directory = path.resolve(storage);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'User') return path.dirname(directory);
    directory = path.dirname(directory);
  }
  throw new Error('Cannot locate VS Code user data from extension storage.');
}

async function inspectRuntime(appRoot, storage, configuredRoot) {
  const product = JSON.parse(await fs.readFile(path.join(appRoot, 'product.json'), 'utf8'));
  const bundled = product.agentSdks?.codex?.version;
  if (!bundled) throw new Error('This VS Code build does not advertise a built-in Codex SDK.');
  stableVersion(bundled);
  const host = target();
  const cacheRoot = path.join(userDataFromStorage(storage), 'agent-host', 'sdk-cache', 'codex', bundled, host.id);
  const root = configuredRoot || cacheRoot;
  let version, error;
  try { version = await binaryVersion(root, host); } catch (e) { error = e.message; }
  return { root, version, error, cacheRoot, bundled, vscodeVersion: product.version, host };
}

module.exports = { SDK_SETTING, target, stableVersion, compareVersions, registryURL, metadata, verifyFile,
  validateArchiveNames, binaryPath, binaryVersion, probe, healthCheck, withLock, install, userDataFromStorage, inspectRuntime,
  packageMetadata, unpack };
