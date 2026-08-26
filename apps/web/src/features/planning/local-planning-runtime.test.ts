import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import { FitnessLocalDatabase } from '../../db/database';
import { createDefaultPlanningSetupForm } from './planning-form';
import {
  LocalPlanningFlowError,
  createLocalPlanningRuntime
} from './local-planning-runtime';

const databases: FitnessLocalDatabase[] = [];
let databaseSequence = 0;

function createDatabase(): FitnessLocalDatabase {
  const database = new FitnessLocalDatabase(`planning-runtime-${String(++databaseSequence)}`);
  databases.push(database);
  return database;
}

function createRuntime(database: FitnessLocalDatabase) {
  let sequence = 0;
  return createLocalPlanningRuntime({
    database,
    now: () => '2026-08-26T08:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    nextIdempotencyKey: () => `web-command-${String(++sequence).padStart(4, '0')}`
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe('local planning runtime', () => {
  test('requires the persisted internal-test boundary confirmation before planning writes', async () => {
    const runtime = createRuntime(createDatabase());
    await runtime.initialize();

    await expect(runtime.submitSetup(createDefaultPlanningSetupForm('2026-08-26')))
      .rejects.toMatchObject({ code: 'test_boundary_confirmation_required' });

    expect(runtime.snapshot.context.latestVersions.bodyProfile).toBe(0);
  });

  test('persists a supported planning setup and restores its authoritative context after refresh', async () => {
    const database = createDatabase();
    const runtime = createRuntime(database);
    await runtime.initialize();
    await runtime.confirmTestBoundary();

    const submitted = await runtime.submitSetup(createDefaultPlanningSetupForm('2026-08-26'));

    expect(submitted.context.latestVersions).toMatchObject({
      bodyProfile: 1,
      goal: 1,
      trainingPlan: 1
    });
    expect(submitted.context.dailyEnergyTargets).toHaveLength(7);
    expect(submitted.context.dailyEnergyTargets.every((target) => (
      target.energy.kind === 'supported'
    ))).toBe(true);
    expect(submitted.context.dailyNutritionTargets.every((target) => (
      target.nutrition?.kind === 'feasible'
    ))).toBe(true);

    const refreshed = createRuntime(database);
    await refreshed.initialize();

    expect(refreshed.snapshot.setupConfirmed).toBe(true);
    expect(refreshed.snapshot.context.bodyProfile?.payload.ageYears).toBe(30);
    expect(refreshed.snapshot.context.dailyNutritionTargets).toHaveLength(7);
  });

  test.each([
    { label: 'age', ageYears: '46', heightCm: '175', weightKg: '60', healthScopeConfirmed: true },
    { label: 'BMI', ageYears: '30', heightCm: '175', weightKg: '73.5', healthScopeConfirmed: true },
    { label: 'health confirmation', ageYears: '30', heightCm: '175', weightKg: '60', healthScopeConfirmed: false }
  ])('stores unsupported $label input but never creates personalized nutrition targets', async (input) => {
    const runtime = createRuntime(createDatabase());
    await runtime.initialize();
    await runtime.confirmTestBoundary();

    const submitted = await runtime.submitSetup({
      ...createDefaultPlanningSetupForm('2026-08-26'),
      ageYears: input.ageYears,
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      healthScopeConfirmed: input.healthScopeConfirmed
    });

    expect(submitted.context.dailyEnergyTargets.every((target) => (
      target.energy.kind === 'unsupported'
    ))).toBe(true);
    expect(submitted.context.dailyNutritionTargets.every((target) => (
      target.nutrition === null
    ))).toBe(true);
  });

  test('keeps immutable setup history and exposes only the latest version as current', async () => {
    const database = createDatabase();
    const runtime = createRuntime(database);
    await runtime.initialize();
    await runtime.confirmTestBoundary();
    await runtime.submitSetup(createDefaultPlanningSetupForm('2026-08-26'));

    const second = await runtime.submitSetup({
      ...createDefaultPlanningSetupForm('2026-08-26'),
      weightKg: '64'
    });
    const stored = await database.planningStates.get('local-default');

    expect(second.context.bodyProfile?.version).toBe(2);
    expect(second.context.bodyProfile?.payload.weightKg).toBe(64);
    expect(stored?.state.bodyProfiles).toHaveLength(2);
    expect(stored?.state.goals).toHaveLength(2);
    expect(stored?.state.trainingPlans).toHaveLength(2);
  });

  test('refreshes authoritative context and fails closed when another tab wins the revision race', async () => {
    const database = createDatabase();
    const first = createRuntime(database);
    const stale = createRuntime(database);
    await first.initialize();
    await first.confirmTestBoundary();
    await stale.initialize();

    await first.submitSetup(createDefaultPlanningSetupForm('2026-08-26'));

    const failure = await stale.submitSetup({
      ...createDefaultPlanningSetupForm('2026-08-26'),
      weightKg: '65'
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalPlanningFlowError);
    expect(failure).toMatchObject({ code: 'planning_version_changed' });
    expect(stale.snapshot.context.bodyProfile?.payload.weightKg).toBe(60);
    const stored = await database.planningStates.get('local-default');
    expect(stored?.state.bodyProfiles).toHaveLength(1);
  });
});
