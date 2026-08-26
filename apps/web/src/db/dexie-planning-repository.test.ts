import 'fake-indexeddb/auto';
import { BroadcastChannel as NodeBroadcastChannel } from 'node:worker_threads';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountCapacityExceededError,
  createVersionedPlanningService
} from '@fitness/application/browser';
import { FitnessLocalDatabase, LOCAL_USER_ID } from './database';
import { DexiePlanningRepository } from './dexie-planning-repository';
import { LocalRevisionConflictError, LocalUserMismatchError } from './errors';

const databaseNames = new Set<string>();

function createDatabase(): FitnessLocalDatabase {
  const name = `fitness-local-test-${crypto.randomUUID()}`;
  databaseNames.add(name);
  return new FitnessLocalDatabase(name);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const name of databaseNames) {
    await Dexie.delete(name);
  }
  databaseNames.clear();
});

describe('DexiePlanningRepository', () => {
  it('starts from an empty local aggregate and persists the first transaction across reloads', async () => {
    const database = createDatabase();
    const repository = new DexiePlanningRepository(database);

    expect(await repository.readExisting(LOCAL_USER_ID)).toBeNull();
    const initial = await repository.read(LOCAL_USER_ID);
    await repository.transact(LOCAL_USER_ID, (current) => ({ nextState: current, result: undefined }));
    repository.close();

    const reopened = new DexiePlanningRepository(new FitnessLocalDatabase(database.name));
    expect(await reopened.readExisting(LOCAL_USER_ID)).toEqual(initial);
    reopened.close();
  });

  it('rolls back when an operation throws before commit', async () => {
    const database = createDatabase();
    const repository = new DexiePlanningRepository(database);

    await expect(repository.transact(LOCAL_USER_ID, () => {
      throw new Error('stop-before-commit');
    })).rejects.toThrow('stop-before-commit');
    expect(await repository.readExisting(LOCAL_USER_ID)).toBeNull();
    repository.close();
  });

  it('rejects access through any user id other than local-default', async () => {
    const repository = new DexiePlanningRepository(createDatabase());

    await expect(repository.read('someone-else')).rejects.toBeInstanceOf(LocalUserMismatchError);
    repository.close();
  });

  it('rejects a stale revision and succeeds after an explicit refresh', async () => {
    const database = createDatabase();
    const first = new DexiePlanningRepository(database);
    const second = new DexiePlanningRepository(new FitnessLocalDatabase(database.name));
    await first.read(LOCAL_USER_ID);
    await second.read(LOCAL_USER_ID);

    await first.transact(LOCAL_USER_ID, (current) => ({ nextState: current, result: undefined }));
    await expect(second.transact(LOCAL_USER_ID, (current) => ({
      nextState: current,
      result: undefined
    }))).rejects.toBeInstanceOf(LocalRevisionConflictError);

    await second.read(LOCAL_USER_ID);
    await expect(second.transact(LOCAL_USER_ID, (current) => ({
      nextState: current,
      result: undefined
    }))).resolves.toBeUndefined();
    first.close();
    second.close();
  });

  it('reports a remote revision through BroadcastChannel until the state is refreshed', async () => {
    vi.stubGlobal('BroadcastChannel', NodeBroadcastChannel);
    const database = createDatabase();
    const first = new DexiePlanningRepository(database);
    const second = new DexiePlanningRepository(new FitnessLocalDatabase(database.name));
    await first.read(LOCAL_USER_ID);
    await second.read(LOCAL_USER_ID);
    expect(second.hasRemoteChanges).toBe(false);

    await first.transact(LOCAL_USER_ID, (current) => ({ nextState: current, result: undefined }));
    await vi.waitFor(() => {
      expect(second.hasRemoteChanges).toBe(true);
    });

    await second.read(LOCAL_USER_ID);
    expect(second.hasRemoteChanges).toBe(false);
    first.close();
    second.close();
  });

  it('rolls back a valid aggregate that exceeds the 3 MB account budget', async () => {
    const repository = new DexiePlanningRepository(createDatabase());
    const oversizedId = `body-profile-${'x'.repeat(3_000_000)}`;
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-26T03:00:00.000Z',
      nextId: () => oversizedId
    });

    await expect(service.saveBodyProfile(LOCAL_USER_ID, {
      expectedVersion: 0,
      idempotencyKey: 'local-profile-create-001',
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
    })).rejects.toBeInstanceOf(AccountCapacityExceededError);
    expect(await repository.readExisting(LOCAL_USER_ID)).toBeNull();
    repository.close();
  });
});
