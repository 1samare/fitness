import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningApiResponseSchema } from '../../packages/contracts/src/planning-api';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const endpoint = 'http://127.0.0.1:3131/';
let service: ChildProcessWithoutNullStreams | undefined;
let output = '';

function startService(): ChildProcessWithoutNullStreams {
  const environment = { ...process.env, PORT: '3131' };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', [
        '/d', '/s', '/c', 'pnpm.cmd', '--filter', '@fitness/planning-api', 'start:local'
      ], { cwd: repositoryRoot, env: environment, shell: false, windowsHide: true })
    : spawn('pnpm', ['--filter', '@fitness/planning-api', 'start:local'], {
        cwd: repositoryRoot,
        env: environment,
        shell: false
      });
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
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

async function waitUntilHealthy(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (service?.exitCode !== null && service?.exitCode !== undefined) {
      throw new Error(`planning-api exited before readiness\n${output}`);
    }
    try {
      const response = planningApiResponseSchema.parse(await call({ action: 'health' }));
      if (response.success && response.data.kind === 'health') return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`planning-api did not become healthy\n${output}`);
}

function stopService(): void {
  if (service?.pid === undefined || service.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(service.pid), '/t', '/f'], { windowsHide: true });
  } else {
    service.kill('SIGTERM');
  }
}

describe('local planning API process', () => {
  beforeAll(async () => {
    service = startService();
    await waitUntilHealthy();
  });

  afterAll(() => {
    stopService();
  });

  it('serves health, supported, and unsupported scenarios', async () => {
    const health = planningApiResponseSchema.parse(await call({ action: 'health' }));
    expect(health.success).toBe(true);
    if (health.success) {
      expect(health.data.kind).toBe('health');
      if (health.data.kind === 'health') {
        expect(health.data.status).toBe('ok');
        expect(health.data.policyVersion).toBe('calculation-policy-v2');
      }
    }

    const supported = planningApiResponseSchema.parse(await call({
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'maintain',
        training: { sessionCode: '02054', durationMinutes: 60 }
      }
    }));
    expect(supported.success).toBe(true);
    if (supported.success) {
      expect(supported.data.kind).toBe('supported');
      if (supported.data.kind === 'supported') expect(supported.data.targetEnergyKcal).toBe(2557);
    }

    const unsupportedRaw = await call({
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 200,
        weightKg: 96,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'fat_loss'
      }
    });
    const unsupported = planningApiResponseSchema.parse(unsupportedRaw);
    expect(unsupported.success).toBe(true);
    if (unsupported.success) {
      expect(unsupported.data.kind).toBe('unsupported');
      if (unsupported.data.kind === 'unsupported') {
        expect(unsupported.data.code).toBe('unsupported_for_personalized_energy');
        expect(unsupported.data.reasons).toEqual(['bmi_out_of_range']);
      }
    }
    expect(JSON.stringify(unsupportedRaw)).not.toContain('targetEnergyKcal');
  });
});
