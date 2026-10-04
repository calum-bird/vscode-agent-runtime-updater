'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const claude = require('../src/claude-runtime');

exports.run = async () => {
  const resultPath = process.env.CLAUDE_UPDATER_TEST_RESULT;
  try {
    await vscode.extensions.getExtension('calumbird-local.codex-agent-updater').activate();
    const commands = await vscode.commands.getCommands(true);
    for (const provider of ['codex', 'claude']) {
      for (const command of ['update', 'check', 'status', 'rollback', 'restore', 'restart']) {
        assert.ok(commands.includes(`${provider}AgentUpdater.${command}`), `${provider} ${command} registered`);
      }
    }
    const root = process.env[claude.ENV];
    const versions = await claude.versions(root);
    await claude.healthCheck(root, versions.sdk);
    await vscode.commands.executeCommand('claudeAgentUpdater.status');
    const logsRoot = path.join(path.dirname(resultPath), 'data/logs');
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const entry of await fs.readdir(logsRoot)) {
        const log = await fs.readFile(path.join(logsRoot, entry, 'agenthost.log'), 'utf8').catch(() => '');
        assert.ok(!log.includes('[Claude] Failed to load @anthropic-ai/claude-agent-sdk'), 'Real host imported SDK');
        if (log.includes('[Claude] Native account check:')) ready = true;
      }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'Real Agent Host completed its Claude SDK account handshake using the supplied override');
    await fs.writeFile(resultPath, JSON.stringify({ success: true, versions, checks: ['both command groups registered', 'Claude status command', 'SDK handshake in Electron', 'real Agent Host native account handshake through override'] }, null, 2));
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({ success: false, error: error.message, stack: error.stack }, null, 2));
    throw error;
  }
};
