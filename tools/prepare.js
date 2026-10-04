#!/usr/bin/env node
'use strict';

// Optional terminal entry point: prepares a runtime without changing VS Code settings.
const runtime = require('../src/runtime');
const path = require('node:path');

async function main() {
  const storage = process.argv[2];
  if (!storage || !path.isAbsolute(storage)) throw new Error('Usage: node tools/prepare.js /absolute/storage/directory');
  const release = await runtime.metadata();
  const root = await runtime.install(storage, release, console.log);
  console.log(JSON.stringify({ version: release.version, sdkRoot: root, setting: runtime.SDK_SETTING }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
