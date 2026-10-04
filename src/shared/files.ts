import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './errors';

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readOptional(file: string) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function readLink(file: string) {
  try {
    if (!(await fs.lstat(file)).isSymbolicLink()) {
      throw new Error(`Expected a managed symlink at ${file}; refusing to replace other content.`);
    }
    return await fs.readlink(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function switchLink(file: string, target: string | null) {
  await readLink(file);
  if (target === null) {
    await fs.rm(file, { force: true });
    return;
  }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.symlink(target, temp, 'dir');
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function withLock<T>(storage: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(storage, { recursive: true });
  const lock = path.join(storage, '.install-lock');
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(
        `Another update is running, or was interrupted. Close other update windows; if none are running, remove ${lock}.`
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function withTemporaryDirectory<T>(
  parent: string,
  prefix: string,
  action: (directory: string) => Promise<T>
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  try {
    return await action(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export {
  atomicWrite,
  readOptional,
  readJson,
  readLink,
  switchLink,
  withLock,
  withTemporaryDirectory,
};
