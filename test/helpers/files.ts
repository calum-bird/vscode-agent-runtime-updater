import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

async function temporary(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-updater-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fakeSdk(root: string, name: string) {
  const directory = path.join(root, name);
  const sdk = path.join(directory, 'node_modules/@anthropic-ai/claude-agent-sdk');
  await fs.mkdir(sdk, { recursive: true });
  await fs.writeFile(path.join(sdk, 'sdk.mjs'), 'export {};');
  return directory;
}

export { temporary, fakeSdk };
