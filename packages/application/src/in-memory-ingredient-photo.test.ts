import { TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS } from '@fitness/nutrition-fixtures';
import type { NutritionProvider } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { describe, expect, test } from 'vitest';
import {
  InMemoryCandidateConfirmationError,
  createInMemoryIngredientPhotoService
} from './in-memory-ingredient-photo';

function requiredTestSnapshot() {
  const value = TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS[0];
  if (value === undefined) throw new Error('Expected a reviewed test nutrition snapshot');
  return value;
}

const snapshot = requiredTestSnapshot();

function harness() {
  const repository = new InMemoryPlanningRepository();
  const nutrition: NutritionProvider = {
    getSnapshot: (id) => id === snapshot.id
      ? Promise.resolve(snapshot)
      : Promise.reject(new Error('missing_snapshot')),
    resolveCanonicalName: (name) => name === snapshot.canonicalNameZh
      ? Promise.resolve({
          foodId: snapshot.foodId,
          canonicalNameZh: snapshot.canonicalNameZh,
          nutritionSnapshotId: snapshot.id
        })
      : Promise.resolve(null)
  };
  let sequence = 0;
  return {
    repository,
    service: createInMemoryIngredientPhotoService({
      repository,
      nutrition,
      allowTestFixtures: true,
      now: () => '2026-08-26T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    })
  };
}

const command = {
  expectedVersion: 0,
  idempotencyKey: 'memory-photo-confirm-001',
  payload: {
    photoId: 'memory-photo-001',
    mediaType: 'image/jpeg' as const,
    candidates: [{
      id: 'memory-candidate-001',
      foodId: snapshot.foodId,
      nutritionSnapshotId: snapshot.id,
      canonicalNameZh: snapshot.canonicalNameZh,
      confidence: 0.94,
      foodState: snapshot.foodState
    }],
    candidateId: 'memory-candidate-001',
    confirmedGrams: 180,
    expectedInventoryVersion: 0
  }
};

describe('in-memory ingredient photo confirmation', () => {
  test('has zero aggregate side effects before explicit confirmation', async () => {
    const { repository } = harness();

    const state = await repository.read('local-default');

    expect(state.ingredientPhotoVersions).toHaveLength(0);
    expect(state.inventories).toHaveLength(0);
    expect(state.idempotencyRecords).toHaveLength(0);
  });

  test('atomically appends a local confirmation audit record and inventory, then replays idempotently', async () => {
    const { repository, service } = harness();

    const first = await service.confirmCandidate('local-default', command);
    const replay = await service.confirmCandidate('local-default', command);
    const state = await repository.read('local-default');

    expect(first).toEqual(replay);
    expect(first.photo).toMatchObject({
      workflowStatus: 'confirmed',
      confirmedGrams: 180
    });
    expect(first.inventory.items).toEqual([{
      foodId: snapshot.foodId,
      nutritionSnapshotId: snapshot.id,
      availableGrams: 180
    }]);
    expect(state.ingredientPhotoVersions).toHaveLength(1);
    expect(state.inventories).toHaveLength(1);
    expect(state.idempotencyRecords).toHaveLength(1);
  });

  test.each([
    { name: 'unknown candidate', payload: { candidateId: 'missing' } },
    { name: 'zero grams', payload: { confirmedGrams: 0 } },
    { name: 'fractional grams', payload: { confirmedGrams: 10.5 } }
  ])('fails closed for $name without partial writes', async ({ payload }) => {
    const { repository, service } = harness();

    const failure = await service.confirmCandidate('local-default', {
      ...command,
      payload: { ...command.payload, ...payload }
    }).catch((error: unknown) => error);
    const state = await repository.read('local-default');

    expect(failure).toBeInstanceOf(InMemoryCandidateConfirmationError);
    expect(state.ingredientPhotoVersions).toHaveLength(0);
    expect(state.inventories).toHaveLength(0);
  });
});
