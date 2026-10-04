import crypto from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { exec } from './process';
import type { Distribution, PackageMetadata } from './types';

const REGISTRY = 'https://registry.npmjs.org';
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT = 30_000;
const MAX_METADATA_SIZE = 2 * 1024 * 1024;
const MAX_DOWNLOAD_SIZE = 512 * 1024 * 1024;
const ARCHIVE_LIST_OPTIONS = { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };

function registryURL(value: string | URL): URL {
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password) {
    throw new Error('Package downloads must come from https://registry.npmjs.org.');
  }
  return url;
}

function request(url: string | URL, redirects = 0): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = https.get(
      registryURL(url),
      {
        headers: { 'User-Agent': 'vscode-codex-agent-updater/0.1.0', Accept: 'application/json' },
      },
      response => {
        if ([301, 302, 307, 308].includes(response.statusCode ?? 0)) {
          response.resume();
          const location = response.headers.location;
          if (redirects >= MAX_REDIRECTS || !location) {
            return reject(new Error('Invalid registry redirect.'));
          }
          Promise.resolve()
            .then(() => request(new URL(location, url), redirects + 1))
            .then(resolve, reject);
        } else if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`npm registry returned HTTP ${response.statusCode}.`));
        } else {
          resolve(response);
        }
      }
    );
    req.setTimeout(REQUEST_TIMEOUT, () =>
      req.destroy(new Error('npm registry request timed out.'))
    );
    req.on('error', reject);
  });
}

async function packageMetadata(name: string, version = 'latest'): Promise<PackageMetadata> {
  const response = await request(
    `${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  );
  let text = '';
  for await (const chunk of response) {
    text += chunk;
    if (text.length > MAX_METADATA_SIZE) {
      response.destroy();
      throw new Error('Registry response too large.');
    }
  }
  const result = JSON.parse(text) as PackageMetadata;
  if (result.name !== name || !result.dist) throw new Error('Unexpected package metadata.');
  return result;
}

function integrityHash(integrity: unknown): string {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw new Error('Package is missing a valid SHA-512 integrity checksum.');
  }
  return integrity.slice(7);
}

async function verifyFile(file: string, integrity: string) {
  const expected = integrityHash(integrity);
  const hash = crypto.createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('base64') !== expected) {
    throw new Error('Package checksum mismatch; installation was not changed.');
  }
}

async function download(dist: Distribution, file: string) {
  integrityHash(dist.integrity);
  const response = await request(dist.tarball);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > MAX_DOWNLOAD_SIZE ? new Error('Package exceeds 512 MiB download limit.') : null,
        chunk
      );
    },
  });
  await pipeline(response, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  await verifyFile(file, dist.integrity);
}

function validateArchiveNames(list: string) {
  const names = list.trim().split('\n');
  if (
    !names.length ||
    names.some(
      name => !name.startsWith('package/') || name.includes('\\') || name.split('/').includes('..')
    )
  ) {
    throw new Error('Unexpected path in package archive.');
  }
}

async function unpack(dist: Distribution, directory: string, archive: string) {
  await download(dist, archive);
  const { stdout } = await exec('tar', ['-tzf', archive], ARCHIVE_LIST_OPTIONS);
  validateArchiveNames(stdout);
  // Reject links before extraction so archive entries cannot write outside staging.
  const listing = await exec('tar', ['-tvzf', archive], ARCHIVE_LIST_OPTIONS);
  if (
    listing.stdout
      .trim()
      .split('\n')
      .some(line => !['-', 'd'].includes(line[0]))
  ) {
    throw new Error('Package archive contains a link or special file.');
  }
  await fs.mkdir(directory, { recursive: true });
  await exec('tar', ['-xzf', archive, '--strip-components=1', '-C', directory], {
    timeout: 120_000,
  });
  await fs.rm(archive);
}

export { registryURL, packageMetadata, verifyFile, validateArchiveNames, unpack };
