import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import { FitnessLocalDatabase } from '../../db/database';
import { createLocalPlanningRuntime, LocalPlanningFlowError } from '../planning/local-planning-runtime';
import { createDefaultPlanningSetupForm } from '../planning/planning-form';

const databases: FitnessLocalDatabase[] = [];
let databaseSequence = 0;

function createHarness() {
  const database = new FitnessLocalDatabase(`meal-runtime-${String(++databaseSequence)}`);
  databases.push(database);
  let sequence = 0;
  const runtime = createLocalPlanningRuntime({
    database,
    now: () => '2026-08-26T08:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    nextIdempotencyKey: () => `meal-command-${String(++sequence).padStart(4, '0')}`
  });
  return { database, runtime };
}

async function completePlanning(
  runtime: ReturnType<typeof createLocalPlanningRuntime>
): Promise<void> {
  await runtime.initialize();
  await runtime.confirmTestBoundary();
  const base = createDefaultPlanningSetupForm('2026-08-31');
  await runtime.submitSetup({
    ...base,
    goal: 'muscle_gain',
    trainingDays: base.trainingDays.map((day, index) => (
      index === 0 || index === 2
        ? {
            ...day,
            enabled: true,
            sessionCode: '02054',
            durationMinutes: '60'
          }
        : day
    ))
  });
}

async function saveCompleteInventory(
  runtime: ReturnType<typeof createLocalPlanningRuntime>
): Promise<void> {
  await runtime.saveInventory(runtime.snapshot.testFoods.map((food) => ({
    name: food.canonicalNameZh,
    availableGrams: 50_000
  })));
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe('local meal planning runtime', () => {
  test('saves reviewed fixture inventory and generates a complete seven-day meal plan', async () => {
    const { runtime } = createHarness();
    await completePlanning(runtime);
    await saveCompleteInventory(runtime);

    const generated = await runtime.generateMealPlan();

    expect(generated.context.inventory?.version).toBe(1);
    expect(generated.context.mealPlan?.days).toHaveLength(7);
    expect(generated.context.mealPlan?.days.every((day) => (
      day.meals.length > 0
      && day.meals.every((meal) => meal.dishNameZh !== undefined)
    ))).toBe(true);
  });

  test('keeps the active meal plan and creates diffs when moving training across a locked day', async () => {
    const { runtime } = createHarness();
    await completePlanning(runtime);
    await saveCompleteInventory(runtime);
    await runtime.generateMealPlan();
    await runtime.setMealPlanDayLock('2026-08-31', true);
    const before = runtime.snapshot.context.mealPlan;
    if (before === null) throw new Error('Expected an active meal plan');
    const unaffectedBefore = before.days.find((day) => day.businessDate === '2026-09-04');

    const moved = await runtime.moveTrainingSession('2026-08-31', '2026-09-01');

    expect(moved.context.mealPlan?.id).toBe(before.id);
    expect(moved.context.pendingMealPlanCandidate).not.toBeNull();
    expect(moved.context.pendingMealPlanTargetDiffs.map((diff) => diff.businessDate).sort())
      .toEqual(['2026-08-31']);
    const candidate = moved.context.pendingMealPlanCandidate;
    if (candidate === null) throw new Error('Expected a pending meal-plan candidate');
    const changedCandidateDates = candidate.days
      .filter((day) => {
        const activeDay = before.days.find((candidateDay) => (
          candidateDay.businessDate === day.businessDate
        ));
        return JSON.stringify(day) !== JSON.stringify(activeDay);
      })
      .map((day) => day.businessDate)
      .sort();
    expect(changedCandidateDates).toEqual(['2026-08-31', '2026-09-01']);
    expect(moved.context.mealPlan?.days.find((day) => day.businessDate === '2026-09-04'))
      .toEqual(unaffectedBefore);
  });

  test('fails closed as provider_unavailable while preserving the current planning context', async () => {
    const { database, runtime } = createHarness();
    await completePlanning(runtime);
    await saveCompleteInventory(runtime);
    await database.testDatasets.clear();

    const failure = await runtime.generateMealPlan().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalPlanningFlowError);
    expect(failure).toMatchObject({ code: 'provider_unavailable' });
    expect(runtime.snapshot.context.inventory?.version).toBe(1);
    expect(runtime.snapshot.context.mealPlan).toBeNull();
  });
});
