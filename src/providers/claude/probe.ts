import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '../../shared/errors';

// Run out of process so SDK imports and CLI children cannot outlive extension activation.
// startup() performs the handshake without sending a prompt or making an inference request.

interface WarmSession {
  close(): void;
}
interface StartupOptions {
  initializeTimeoutMs: number;
  options: {
    cwd: string;
    settingSources: string[];
    plugins: unknown[];
    tools: string[];
    mcpServers: Record<string, unknown>;
    strictMcpConfig: boolean;
    persistSession: boolean;
    env: NodeJS.ProcessEnv;
  };
}
interface ClaudeSdk extends Record<string, unknown> {
  startup(options: StartupOptions): Promise<WarmSession>;
}

function assertSdkMethods(sdk: Record<string, unknown>): asserts sdk is ClaudeSdk {
  for (const method of [
    'query',
    'listSessions',
    'getSessionMessages',
    'getSessionInfo',
    'listSubagents',
    'getSubagentMessages',
    'deleteSession',
    'forkSession',
    'createSdkMcpServer',
    'tool',
    'startup',
  ]) {
    if (typeof sdk[method] !== 'function') {
      throw new Error(`Claude SDK is missing ${method} required by this integration.`);
    }
  }
}

async function main() {
  const [root, temporaryHome] = process.argv.slice(2);
  if (!root || !temporaryHome)
    throw new Error('The Claude probe requires an SDK root and temporary home.');
  const sdkPath = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  const sdk = (await import(pathToFileURL(sdkPath).href)) as Record<string, unknown>;
  assertSdkMethods(sdk);
  let warm: WarmSession | undefined;
  try {
    warm = await sdk.startup({
      initializeTimeoutMs: 20_000,
      options: {
        cwd: temporaryHome,
        settingSources: [],
        plugins: [],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        env: { ...process.env, CLAUDE_CONFIG_DIR: temporaryHome },
      },
    });
    console.log(JSON.stringify({ initialized: true }));
  } finally {
    warm?.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
