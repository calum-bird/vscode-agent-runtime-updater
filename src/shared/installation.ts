import fs from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './errors';
import { withLock, withTemporaryDirectory } from './files';
import type { unpack } from './registry';
import type { Host } from './types';

export interface InstallationDependencies<H extends Host> {
  host?: H;
  unpack?: typeof unpack;
  healthCheck?: (root: string, version: string, host: H) => Promise<unknown>;
}

interface Installation<H extends Host> {
  version: string;
  host: H;
  healthCheck: (root: string, version: string, host: H) => Promise<unknown>;
  stage: (directory: string) => Promise<Record<string, unknown>>;
}

// Providers supply package layout and health checks. Publication and cleanup
// follow the same rules for both providers: verify first, then rename atomically.
async function installVerified<H extends Host>(
  storage: string,
  { version, host, healthCheck, stage }: Installation<H>
): Promise<string> {
  return withLock(storage, async () => {
    const finalRoot = path.join(storage, 'versions', version, host.id);
    try {
      await fs.access(finalRoot);
      await healthCheck(finalRoot, version, host);
      return finalRoot;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    return withTemporaryDirectory(storage, '.staging-', async staging => {
      const details = await stage(staging);
      await healthCheck(staging, version, host);
      const record = {
        ...details,
        version,
        target: host.id,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(staging, 'installation.json'), JSON.stringify(record, null, 2));
      await fs.mkdir(path.dirname(finalRoot), { recursive: true });
      await fs.rename(staging, finalRoot);
      return finalRoot;
    });
  });
}

export { installVerified };
