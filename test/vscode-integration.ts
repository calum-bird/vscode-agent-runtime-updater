import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../src/shared/errors';

export async function run() {
  const resultPath = process.env.CODEX_UPDATER_TEST_RESULT;
  assert.ok(resultPath, 'The integration runner needs CODEX_UPDATER_TEST_RESULT.');
  try {
    const extension = vscode.extensions.getExtension('calumbird-local.codex-agent-updater');
    assert.ok(extension, 'Extension discovered');
    await extension.activate();
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update('codexAgentUpdater.checkOnStartup', false, vscode.ConfigurationTarget.Global);
    const key = 'chat.agentHost.codexAgent.sdkRoot';
    if (process.env.CODEX_UPDATER_TEST_LOADER === '1') {
      const selected = cfg.get<string>(key);
      assert.ok(selected, 'SDK root saved by the command test');
      await cfg.update(
        'chat.agentHost.codexAgent.enabled',
        true,
        vscode.ConfigurationTarget.Global
      );
      await cfg.update(
        'chat.agentHost.allowSignedOutWhenUsable',
        true,
        vscode.ConfigurationTarget.Global
      );
      // Only the isolated test instance is restarted, never the user's host.
      await vscode.commands.executeCommand('workbench.action.chat.restartLocalAgentHost');
      const logsRoot = path.join(path.dirname(resultPath), 'data', 'logs');
      let loaded = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        for (const entry of await fs.readdir(logsRoot)) {
          const log = await fs
            .readFile(path.join(logsRoot, entry, 'agenthost.log'), 'utf8')
            .catch(() => '');
          if (log.includes(`[Codex] spawning app-server from ${selected}`)) loaded = true;
        }
        if (loaded) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(loaded, 'Real Agent Host spawned Codex from the selected SDK root');
      await fs.writeFile(
        resultPath,
        JSON.stringify(
          { success: true, selected, checks: ['real Agent Host loads SDK override after restart'] },
          null,
          2
        )
      );
      return;
    }
    assert.equal(cfg.get<string>(key) || '', '');
    await vscode.commands.executeCommand('codexAgentUpdater.update');
    const selected = vscode.workspace.getConfiguration().get<string>(key);
    assert.ok(selected?.includes('/versions/0.160.0/'), `Update selected runtime: ${selected}`);
    await vscode.commands.executeCommand('codexAgentUpdater.rollback');
    assert.equal(
      vscode.workspace.getConfiguration().get<string>(key) || '',
      '',
      'Rollback restored absent setting'
    );
    await vscode.commands.executeCommand('codexAgentUpdater.update');
    assert.equal(
      vscode.workspace.getConfiguration().get<string>(key),
      selected,
      'Repeat update works'
    );
    await vscode.commands.executeCommand('codexAgentUpdater.restore');
    assert.equal(
      vscode.workspace.getConfiguration().get<string>(key) || '',
      '',
      'Restore original works'
    );
    // Leave an override only in this isolated test profile for host-loader verification.
    await vscode.commands.executeCommand('codexAgentUpdater.update');
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('workbench.action.chat.restartLocalAgentHost'));
    await fs.writeFile(
      resultPath,
      JSON.stringify(
        {
          success: true,
          selected,
          checks: [
            'activation',
            'update',
            'rollback',
            'repeat update',
            'restore original',
            'restart command present',
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
          message: errorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        null,
        2
      )
    );
    throw error;
  }
}
