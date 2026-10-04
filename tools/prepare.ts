#!/usr/bin/env node
import path from 'node:path';
import { SDK_SETTING } from '../src/providers/codex/constants';
import * as runtime from '../src/providers/codex/runtime';
import { errorMessage } from '../src/shared/errors';

// Optional terminal entry point: prepares a runtime without changing VS Code settings.

async function main() {
  const storage = process.argv[2];
  if (!storage || !path.isAbsolute(storage)) {
    throw new Error('Usage: node dist/tools/prepare.js /absolute/storage/directory');
  }
  const release = await runtime.metadata();
  const root = await runtime.install(storage, release, console.log);
  console.log(
    JSON.stringify({ version: release.version, sdkRoot: root, setting: SDK_SETTING }, null, 2)
  );
}
main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
