import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { isRecord } from '../../shared/json';

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  [key: string]: unknown;
}

export interface Model {
  model: string;
  [key: string]: unknown;
}

export interface ModelProbeResult extends InitializeResult {
  models: Model[];
}

interface ProbeOptions {
  codexHome?: string;
  models?: boolean;
  timeoutMs?: number;
}

function isModel(value: unknown): value is Model {
  return isRecord(value) && typeof value.model === 'string';
}

const INITIALIZE_ID = 1;
const MODEL_PAGE_SIZE = 100;
const MAX_MODEL_CURSORS = 50;
const KILL_DELAY = 2000;

function probe(binary: string, options: ProbeOptions & { models: true }): Promise<ModelProbeResult>;
function probe(binary: string, options?: ProbeOptions): Promise<InitializeResult>;
async function probe(
  binary: string,
  { codexHome, models = false, timeoutMs = 30_000 }: ProbeOptions = {}
): Promise<InitializeResult | ModelProbeResult> {
  return new Promise<InitializeResult | ModelProbeResult>((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let initialized: InitializeResult | undefined;
    let modelRequestId = INITIALIZE_ID + 1;
    const foundModels: Model[] = [];
    const cursors = new Set<string>();
    const timer = setTimeout(
      () => finish(new Error('Codex app-server health check timed out.')),
      timeoutMs
    );
    function finish(error: Error | null, value?: InitializeResult | ModelProbeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_DELAY);
      killTimer.unref();
      child.once('close', () => {
        clearTimeout(killTimer);
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new Error('Codex health check completed without a result.'));
      });
    }
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);

    function requestModels(cursor?: string) {
      send({
        id: modelRequestId,
        method: 'model/list',
        params: { cursor, limit: MODEL_PAGE_SIZE, includeHidden: false },
      });
    }

    function handleInitialize(result: unknown) {
      if (
        !isRecord(result) ||
        typeof result.userAgent !== 'string' ||
        typeof result.codexHome !== 'string'
      ) {
        finish(
          new Error('Codex initialize response is incompatible with this VS Code integration.')
        );
        return;
      }
      initialized = { ...result, userAgent: result.userAgent, codexHome: result.codexHome };
      send({ method: 'initialized' });
      if (models) requestModels();
      else finish(null, initialized);
    }

    function handleModels(result: unknown) {
      if (
        !isRecord(result) ||
        !Array.isArray(result.data) ||
        !result.data.every(isModel) ||
        !initialized
      ) {
        finish(new Error('Invalid Codex model/list response.'));
        return;
      }
      foundModels.push(...result.data);
      const cursor = result.nextCursor;
      if (!cursor) {
        finish(null, { ...initialized, models: foundModels });
        return;
      }
      if (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size > MAX_MODEL_CURSORS) {
        finish(new Error('Invalid model pagination.'));
        return;
      }
      cursors.add(cursor);
      modelRequestId++;
      requestModels(cursor);
    }

    function handleLine(line: string) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.error) {
        const detail = isRecord(message.error) ? message.error.message : message.error;
        finish(new Error(`Codex health check: ${String(detail)}`));
      } else if (message.id === INITIALIZE_ID) {
        handleInitialize(message.result);
      } else if (models && message.id === modelRequestId) {
        handleModels(message.result);
      }
    }

    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', (code, signal) =>
      finish(new Error(`Codex app-server exited early (${signal || code}).`))
    );
    child.stderr.resume(); // Drain stderr without logging account/configuration details.
    lines.on('line', handleLine);
    send({
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex_agent_updater', title: 'Codex Agent Updater', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export { probe };
