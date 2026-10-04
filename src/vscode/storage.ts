import path from 'node:path';
import { readJson } from '../shared/files';
import type { Host } from '../shared/types';
import { stableVersion } from '../shared/versions';

interface Product {
  version: string;
  agentSdks?: Record<string, { version?: string }>;
}

function userDataFromStorage(storage: string): string {
  // Default and named profiles both keep extension storage under User/.
  let directory = path.resolve(storage);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'User') return path.dirname(directory);
    directory = path.dirname(directory);
  }
  throw new Error('Cannot locate VS Code user data from extension storage.');
}

async function bundledRuntime<H extends Host>(
  appRoot: string,
  storage: string,
  provider: string,
  host: H
) {
  const product = await readJson<Product>(path.join(appRoot, 'product.json'));
  const bundled = product.agentSdks?.[provider]?.version;
  if (!bundled)
    throw new Error(`This VS Code build does not advertise a built-in ${provider} SDK.`);
  stableVersion(bundled);
  const cacheRoot = path.join(
    userDataFromStorage(storage),
    'agent-host',
    'sdk-cache',
    provider,
    bundled,
    host.id
  );
  return { bundled, cacheRoot, vscodeVersion: product.version, host };
}

export { userDataFromStorage, bundledRuntime };
