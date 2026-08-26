import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import { FitnessLocalDatabase } from '../../db/database';
import { DexiePlanningRepository } from '../../db/dexie-planning-repository';
import { initializeLocalData } from '../../db/initialize-local-data';
import { readLocalTestFoods } from '../meals/local-meal-providers';
import {
  LocalVisionUnavailableError,
  createLocalImageCandidateRuntime
} from './local-image-candidate-runtime';

const databases: FitnessLocalDatabase[] = [];
let databaseSequence = 0;

function database(): FitnessLocalDatabase {
  const value = new FitnessLocalDatabase(`image-runtime-${String(++databaseSequence)}`);
  databases.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (target) => {
    target.close();
    await target.delete();
  }));
});

describe('local image candidate runtime', () => {
  test('maps at most five fixture candidates, writes nothing before confirmation, then releases image memory', async () => {
    const target = database();
    await initializeLocalData(target, '2026-08-26T08:00:00.000Z');
    const foods = await readLocalTestFoods(target);
    const selected = foods[0];
    if (selected === undefined) throw new Error('Expected a local test food');
    let sequence = 0;
    const runtime = createLocalImageCandidateRuntime({
      database: target,
      prepareImage: () => Promise.resolve({
        mediaType: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,Zm9vZA==',
        sizeBytes: 4
      }),
      vision: {
        recognize: () => Promise.resolve({
          requestId: 'vision-request-001',
          candidates: [
            { name: selected.canonicalNameZh, confidence: 0.96, foodState: selected.foodState },
            { name: '不存在的模型食材', confidence: 0.88, foodState: 'raw' }
          ]
        })
      },
      now: () => '2026-08-26T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`,
      nextIdempotencyKey: () => `image-confirm-${String(++sequence)}`
    });
    const file = new File(['food'], 'food.jpg', { type: 'image/jpeg' });

    await runtime.selectFile(file);
    const recognized = await runtime.recognize();
    const repository = new DexiePlanningRepository(target);
    const before = await repository.read('local-default');

    expect(recognized.candidates).toHaveLength(1);
    expect(recognized.candidates[0]).toMatchObject({
      foodId: selected.foodId,
      nutritionSnapshotId: selected.nutritionSnapshotId
    });
    expect(before.ingredientPhotoVersions).toHaveLength(0);
    expect(before.inventories).toHaveLength(0);
    expect(runtime.hasPreparedImage).toBe(true);

    const candidate = recognized.candidates[0];
    if (candidate === undefined) throw new Error('Expected a mapped image candidate');
    const confirmed = await runtime.confirm(candidate.id, 180);
    const after = await repository.read('local-default');

    expect(confirmed.inventory.items).toContainEqual({
      foodId: selected.foodId,
      nutritionSnapshotId: selected.nutritionSnapshotId,
      availableGrams: 180
    });
    expect(after.ingredientPhotoVersions).toHaveLength(1);
    expect(runtime.hasPreparedImage).toBe(false);
    expect(runtime.snapshot.status).toBe('confirmed');
  });

  test('releases image memory and keeps manual inventory available after vision failure', async () => {
    const target = database();
    await initializeLocalData(target, '2026-08-26T08:00:00.000Z');
    const runtime = createLocalImageCandidateRuntime({
      database: target,
      prepareImage: () => Promise.resolve({
        mediaType: 'image/png',
        dataUrl: 'data:image/png;base64,Zm9vZA==',
        sizeBytes: 4
      }),
      vision: {
        recognize: () => Promise.reject(new LocalVisionUnavailableError())
      },
      now: () => '2026-08-26T08:00:00.000Z'
    });

    await runtime.selectFile(new File(['food'], 'food.png', { type: 'image/png' }));
    const failure = await runtime.recognize().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalVisionUnavailableError);
    expect(runtime.hasPreparedImage).toBe(false);
    expect(runtime.snapshot).toMatchObject({ status: 'manual_fallback', candidates: [] });
  });
});
