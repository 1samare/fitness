import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantApiResponseSchema } from '../../packages/contracts/src/index';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assistantApiRoot = path.join(repositoryRoot, 'cloudfunctions', 'assistant-api');
const frameworkCli = path.join(
  assistantApiRoot,
  'node_modules',
  '@cloudbase',
  'functions-framework',
  'bin',
  'tcb-ff.js'
);
let endpoint = '';
let port = 0;
let service: ChildProcessWithoutNullStreams | undefined;
let output = '';
let spawnError: Error | undefined;

async function reserveAvailablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    listener.close();
    throw new Error('Could not allocate a local TCP port.');
  }
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
}

function startService(servicePort: number): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    frameworkCli,
    '--source=dist/index.js',
    '--target=main',
    '--logEventContext=false',
    '--logHeaderBody=false'
  ], {
    cwd: assistantApiRoot,
    env: {
      ...process.env,
      PORT: String(servicePort),
      FITNESS_RUNTIME_MODE: 'local',
      FITNESS_LOCAL_USER_ID: 'assistant-smoke-user'
    },
    shell: false,
    windowsHide: true
  });
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.once('error', (error) => { spawnError = error; });
  return child;
}

async function call(request: unknown): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      throw new Error(`assistant-api could not be started: ${spawnError.message}\n${output}`);
    }
    if (service?.exitCode !== null && service?.exitCode !== undefined) {
      throw new Error(`assistant-api exited before readiness\n${output}`);
    }
    try {
      const response = assistantApiResponseSchema.parse(
        await call({ action: 'getAssistantConversation' })
      );
      if (response.success && response.data.kind === 'assistant_conversation') return;
    } catch {
      // The child may not have bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`assistant-api did not become ready\n${output}`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('assistant-api did not exit after termination.'));
    }, 5_000);
    const onClose = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once('close', onClose);
    if (child.exitCode !== null) {
      child.off('close', onClose);
      onClose();
    }
  });
}

async function confirmPortReleased(servicePort: number): Promise<void> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', (error) => {
      reject(new Error(
        `assistant-api port ${String(servicePort)} was not released: ${error.message}`
      ));
    });
    listener.listen(servicePort, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function stopService(): Promise<void> {
  const child = service;
  if (child?.pid !== undefined && child.exitCode === null) {
    const exitPromise = waitForExit(child);
    if (!child.kill('SIGTERM')) throw new Error('Failed to terminate assistant-api process.');
    await exitPromise;
  }
  if (port !== 0) await confirmPortReleased(port);
}

describe('local assistant API process', () => {
  beforeAll(async () => {
    port = await reserveAvailablePort();
    endpoint = `http://127.0.0.1:${String(port)}/`;
    service = startService(port);
    await waitUntilReady();
  });

  afterAll(async () => { await stopService(); });

  it('serves conversation, deterministic clarification, and Provider-safe fallback', async () => {
    const initial = assistantApiResponseSchema.parse(
      await call({ action: 'getAssistantConversation' })
    );
    expect(initial).toMatchObject({
      success: true,
      data: { kind: 'assistant_conversation', conversationVersion: 0, pendingTurn: null }
    });

    const clarified = assistantApiResponseSchema.parse(await call({
      action: 'sendAssistantMessage',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'assistant-smoke-clarify-0001',
        message: '把 2026-08-24 的训练移到另一日'
      }
    }));
    expect(clarified).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        conversationVersion: 1,
        result: { kind: 'clarification_required', missingFields: ['target_date'] }
      }
    });

    const unavailable = assistantApiResponseSchema.parse(await call({
      action: 'sendAssistantMessage',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'assistant-smoke-provider-0001',
        message: '本地烟测：模拟模型不可用'
      }
    }));
    expect(unavailable).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        conversationVersion: 2,
        result: {
          kind: 'assistant_unavailable',
          reason: 'provider_unavailable',
          recoveryAction: 'retry'
        }
      }
    });

    const finalConversation = assistantApiResponseSchema.parse(
      await call({ action: 'getAssistantConversation' })
    );
    expect(finalConversation).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_conversation',
        conversationVersion: 2,
        pendingTurn: null,
        messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }]
      }
    });
    expect(JSON.stringify({ clarified, unavailable, finalConversation }))
      .not.toMatch(/assistant-smoke-user|supplier|providerId|modelName/);
  });
});
