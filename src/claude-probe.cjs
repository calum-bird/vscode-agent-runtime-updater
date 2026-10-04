'use strict';

// Run out of process so SDK imports and CLI children cannot outlive extension activation.
// startup() performs the handshake without sending a prompt or making an inference request.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const [root, temporaryHome] = process.argv.slice(2);
  const sdk = await import(pathToFileURL(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).href);
  for (const method of ['query', 'listSessions', 'getSessionMessages', 'getSessionInfo', 'listSubagents', 'getSubagentMessages', 'deleteSession', 'forkSession', 'createSdkMcpServer', 'tool', 'startup']) {
    if (typeof sdk[method] !== 'function') throw new Error(`Claude SDK is missing ${method} required by this integration.`);
  }
  let warm;
  try {
    warm = await sdk.startup({ initializeTimeoutMs: 20_000, options: {
      cwd: temporaryHome, settingSources: [], plugins: [], tools: [],
      mcpServers: {}, strictMcpConfig: true, persistSession: false,
      env: { ...process.env, CLAUDE_CONFIG_DIR: temporaryHome },
    } });
    console.log(JSON.stringify({ initialized: true }));
  } finally { warm?.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
