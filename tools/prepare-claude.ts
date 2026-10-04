#!/usr/bin/env node
import path from 'node:path';
import { createBinding } from '../src/providers/claude/binding';
import * as claude from '../src/providers/claude/runtime';
import { errorMessage } from '../src/shared/errors';

async function main() {
  const storage = process.argv[2];
  if (!storage || !path.isAbsolute(storage)) {
    throw new Error('Usage: node dist/tools/prepare-claude.js /absolute/claude-storage [--select]');
  }
  const selected = process.argv.includes('--select');
  const release = await claude.metadata();
  const root = await claude.install(storage, release, console.log);
  if (selected) await createBinding(storage).select(root);
  console.log(
    JSON.stringify(
      {
        sdk: release.version,
        claudeCode: release.claudeCodeVersion,
        root,
        selected,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
