import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningApiResponseSchema } from '../../packages/contracts/src/planning-api';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const planningApiRoot = path.join(repositoryRoot, 'cloudfunctions', 'planning-api');
const frameworkCli = path.join(
  planningApiRoot,
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
  const environment = {
    ...process.env,
    PORT: String(servicePort),
    FITNESS_RUNTIME_MODE: 'local',
    FITNESS_LOCAL_USER_ID: 'smoke-test-user'
  };
  const child = spawn(process.execPath, [
    frameworkCli,
    '--source=dist/index.js',
    '--target=main',
    '--logEventContext=false',
    '--logHeaderBody=false'
  ], {
    cwd: planningApiRoot,
    env: environment,
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

async function waitUntilHealthy(): Promise<void> {
  const deadline = Date.now() + 15_000;
  const readinessMarker = `Server listening on port ${String(port)},`;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      throw new Error(`planning-api could not be started: ${spawnError.message}\n${output}`);
    }
    if (service?.exitCode !== null && service?.exitCode !== undefined) {
      throw new Error(`planning-api exited before readiness\n${output}`);
    }
    if (output.includes(readinessMarker)) {
      try {
        const response = planningApiResponseSchema.parse(await call({ action: 'health' }));
        if (response.success && response.data.kind === 'health') return;
      } catch {
        // The child announced readiness; allow the socket a short time to accept requests.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`planning-api did not report its own readiness and become healthy\n${output}`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('planning-api did not exit after termination.'));
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
      reject(new Error(`planning-api port ${String(servicePort)} was not released: ${error.message}`));
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
    if (!child.kill('SIGTERM')) {
      throw new Error('Failed to terminate planning-api process.');
    }
    await exitPromise;
  }
  if (port !== 0) await confirmPortReleased(port);
}

describe('local planning API process', () => {
  beforeAll(async () => {
    port = await reserveAvailablePort();
    endpoint = `http://127.0.0.1:${String(port)}/`;
    service = startService(port);
    await waitUntilHealthy();
  });

  afterAll(async () => {
    await stopService();
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

    const profile = planningApiResponseSchema.parse(await call({
      action: 'saveBodyProfile',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'smoke-profile-001',
        payload: {
          ageYears: 30,
          sexCode: 0,
          heightCm: 175,
          weightKg: 70,
          healthScopeConfirmed: true,
          nonTrainingActivity: 'light',
          allergens: [],
          avoidFoods: [],
          dietPreferences: [],
          businessTimezone: 'Asia/Shanghai'
        }
      }
    }));
    expect(profile.success && profile.data.kind === 'body_profile_saved').toBe(true);

    const goal = planningApiResponseSchema.parse(await call({
      action: 'saveGoal',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'smoke-goal-001',
        payload: {
          goal: 'maintain',
          effectiveDate: '2026-08-03',
          targetDate: '2026-10-26'
        }
      }
    }));
    expect(goal.success && goal.data.kind === 'goal_saved').toBe(true);

    const training = planningApiResponseSchema.parse(await call({
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'smoke-training-001',
        payload: {
          weekStartDate: '2026-08-03',
          businessTimezone: 'Asia/Shanghai',
          sessions: [{
            businessDate: '2026-08-04',
            sessionCode: '02054',
            durationMinutes: 60
          }]
        }
      }
    }));
    expect(training.success && training.data.kind === 'training_plan_saved').toBe(true);

    const context = planningApiResponseSchema.parse(await call({ action: 'getCurrentContext' }));
    expect(context.success && context.data.kind === 'current_context').toBe(true);
    if (context.success && context.data.kind === 'current_context') {
      expect(context.data.bodyProfile?.version).toBe(1);
      expect(context.data.goal?.version).toBe(1);
      expect(context.data.trainingPlan?.version).toBe(1);
      expect(context.data.dailyEnergyTargets).toHaveLength(7);
    }
  });
});
