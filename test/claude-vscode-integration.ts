import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import * as claude from '../src/providers/claude/runtime';
import { errorMessage } from '../src/shared/errors';

export async function run() {
  const resultPath = process.env.CLAUDE_UPDATER_TEST_RESULT;
  assert.ok(resultPath, 'The integration runner needs CLAUDE_UPDATER_TEST_RESULT.');
  try {
    const extension = vscode.extensions.getExtension('calumbird-local.codex-agent-updater');
    assert.ok(extension, 'Extension discovered');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const provider of ['codex', 'claude']) {
      for (const command of ['update', 'check', 'status', 'rollback', 'restore', 'restart']) {
        assert.ok(
          commands.includes(`${provider}AgentUpdater.${command}`),
          `${provider} ${command} registered`
        );
      }
    }
    const root = process.env[claude.ENV];
    assert.ok(root, 'The integration runner needs a Claude SDK override.');
    const versions = await claude.versions(root);
    await claude.healthCheck(root, versions.sdk);
    await vscode.commands.executeCommand('claudeAgentUpdater.status');
    const logsRoot = path.join(path.dirname(resultPath), 'data/logs');
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const entry of await fs.readdir(logsRoot)) {
        const log = await fs
          .readFile(path.join(logsRoot, entry, 'agenthost.log'), 'utf8')
          .catch(() => '');
        assert.ok(
          !log.includes('[Claude] Failed to load @anthropic-ai/claude-agent-sdk'),
          'Real host imported SDK'
        );
        if (log.includes('[Claude] Native account check:')) ready = true;
      }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(
      ready,
      'Real Agent Host completed its Claude SDK account handshake using the supplied override'
    );
    await fs.writeFile(
      resultPath,
      JSON.stringify(
        {
          success: true,
          versions,
          checks: [
            'both command groups registered',
            'Claude status command',
            'SDK handshake in Electron',
            'real Agent Host native account handshake through override',
          ],
        },
        null,
        2
      )
    );
  } catch (error) {
    await fs.writeFile(
      resultPath,
      JSON.stringify(
        {
          success: false,
          error: errorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        null,
        2
      )
    );
    throw error;
  }
}
