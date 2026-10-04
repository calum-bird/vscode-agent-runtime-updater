#!/usr/bin/env node
'use strict';
const claude = require('../src/claude-runtime');
const { createBinding } = require('../src/claude-binding');
const path = require('node:path');
(async () => {
  const storage = process.argv[2];
  if (!storage || !path.isAbsolute(storage)) throw new Error('Usage: node tools/prepare-claude.js /absolute/claude-storage [--select]');
  const release = await claude.metadata();
  const root = await claude.install(storage, release, console.log);
  if (process.argv.includes('--select')) await createBinding(storage).select(root);
  console.log(JSON.stringify({ sdk: release.version, claudeCode: release.claudeCodeVersion, root, selected: process.argv.includes('--select') }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
