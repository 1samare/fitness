import { describe, expect, test, vi } from 'vitest';
import { createVersionedPlanningService } from '@fitness/application';
import {
  CloudBasePlanningRepository,
  CorruptPlanningStateError,
  type CloudBaseDatabase,
  type CloudBaseDocumentReference,
  type CloudBaseTransaction
} from './cloudbase-planning-repository';

class FakeDocumentReference implements CloudBaseDocumentReference {
  public constructor(
    private readonly documents: Map<string, unknown>,
    private readonly key: string
  ) {}

  public get(): Promise<{ readonly data?: unknown }> {
    const data = this.documents.get(this.key);
    return Promise.resolve(data === undefined ? {} : { data });
  }

  public set(input: { readonly data: unknown }): Promise<unknown> {
    this.documents.set(this.key, input.data);
    return Promise.resolve({ updated: 1 });
  }
}

class FakeDatabase implements CloudBaseDatabase, CloudBaseTransaction {
  public readonly documents = new Map<string, unknown>();
  public readonly requestedKeys: string[] = [];

  public collection(name: string) {
    return {
      doc: (id: string) => {
        const key = `${name}/${id}`;
        this.requestedKeys.push(key);
        return new FakeDocumentReference(this.documents, key);
      }
    };
  }

  public runTransaction<TResult>(
    operation: (transaction: CloudBaseTransaction) => Promise<TResult>
  ): Promise<TResult> {
    return operation(this);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replaceStoredFingerprint(
  database: FakeDatabase,
  documentKey: string,
  requestFingerprint: string
): void {
  const document = database.documents.get(documentKey);
  if (!isRecord(document) || !isRecord(document.state)) {
    throw new Error('Expected a stored planning document');
  }
  const records = document.state.idempotencyRecords;
  if (!Array.isArray(records) || records.length !== 1 || !isRecord(records[0])) {
    throw new Error('Expected one stored idempotency record');
  }
  database.documents.set(documentKey, {
    ...document,
    state: {
      ...document.state,
      idempotencyRecords: [{
        ...records[0],
        requestFingerprint
      }]
    }
  });
}

describe('CloudBasePlanningRepository', () => {
  test('initializes missing state without the Node 17 structuredClone global', async () => {
    vi.stubGlobal('structuredClone', undefined);
    try {
      const repository = new CloudBasePlanningRepository(new FakeDatabase());

      await expect(repository.read('wx-openid-a')).resolves.toMatchObject({
        inventories: [],
        mealPlans: [],
        mealPlanTargetDiffs: [],
        mealPlanDecisions: [],
        trainingCompletionEvents: [],
        recalculationJobs: [],
        activeInventoryVersionId: null,
        activeMealPlanVersionId: null
      });
      await expect(repository.transact('wx-openid-a', (state) => ({
        nextState: state,
        result: 'initialized'
      }))).resolves.toBe('initialized');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('persists validated state across repository instances without exposing OpenID in the key', async () => {
    const database = new FakeDatabase();
    const firstRepository = new CloudBasePlanningRepository(database);
    const service = createVersionedPlanningService({
      repository: firstRepository,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-1`
    });

    await service.saveBodyProfile('wx-openid-sensitive', {
      expectedVersion: 0,
      idempotencyKey: 'profile-create-001',
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
    });

    const secondRepository = new CloudBasePlanningRepository(database);
    const state = await secondRepository.read('wx-openid-sensitive');
    expect(state.bodyProfiles).toHaveLength(1);
    expect(database.documents).toHaveLength(1);
    expect(database.requestedKeys.join('|')).not.toContain('wx-openid-sensitive');
    expect([...database.documents.values()][0]).toEqual(expect.objectContaining({
      schemaVersion: 4
    }));
  });

  test('migrates schema v2 structurally without synthesizing historical nutrition values', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const documentKey = `planning_user_states/${repository.documentIdForUser('wx-openid-a')}`;
    database.documents.set(documentKey, {
      schemaVersion: 2,
      state: {
        bodyProfiles: [],
        goals: [],
        trainingPlans: [],
        dailyEnergyTargets: [],
        outboxEvents: [],
        idempotencyRecords: [],
        activeBodyProfileVersionId: null,
        activeGoalVersionId: null,
        activeTrainingPlanVersionId: null
      }
    });

    await expect(repository.read('wx-openid-a')).resolves.toMatchObject({
      dailyNutritionTargets: [],
      inventories: [],
      mealPlans: [],
      mealPlanTargetDiffs: [],
      mealPlanDecisions: [],
      trainingCompletionEvents: [],
      recalculationJobs: [],
      activeInventoryVersionId: null,
      activeMealPlanVersionId: null
    });
    expect(database.documents.get(documentKey)).not.toHaveProperty(
      'state.dailyNutritionTargets'
    );
    await repository.transact('wx-openid-a', (state) => ({ nextState: state, result: undefined }));
    const migrated = database.documents.get(documentKey);
    expect(isRecord(migrated) ? migrated.schemaVersion : undefined).toBe(4);
    expect(isRecord(migrated) && isRecord(migrated.state)
      ? migrated.state.dailyNutritionTargets
      : undefined).toEqual([]);
  });

  test('migrates schema v3 to empty phase-4 state without mutating the stored input', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const documentKey = `planning_user_states/${repository.documentIdForUser('wx-openid-a')}`;
    const stored = {
      schemaVersion: 3,
      state: {
        bodyProfiles: [],
        goals: [],
        trainingPlans: [],
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        outboxEvents: [],
        idempotencyRecords: [],
        activeBodyProfileVersionId: null,
        activeGoalVersionId: null,
        activeTrainingPlanVersionId: null
      }
    };
    const before = structuredClone(stored);
    database.documents.set(documentKey, stored);

    await expect(repository.read('wx-openid-a')).resolves.toMatchObject({
      inventories: [],
      mealPlans: [],
      mealPlanTargetDiffs: [],
      mealPlanDecisions: [],
      trainingCompletionEvents: [],
      recalculationJobs: [],
      activeInventoryVersionId: null,
      activeMealPlanVersionId: null
    });
    expect(stored).toEqual(before);
    expect(database.documents.get(documentKey)).toEqual(before);
  });

  test('fails closed instead of replacing a corrupt stored state', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const documentId = repository.documentIdForUser('wx-openid-a');
    database.documents.set(`planning_user_states/${documentId}`, {
      schemaVersion: 2,
      state: { bodyProfiles: 'not-an-array' }
    });

    await expect(repository.read('wx-openid-a')).rejects.toBeInstanceOf(
      CorruptPlanningStateError
    );
  });

  test.each([
    '{"weightKg":70}',
    `v1:sha256:${'a'.repeat(64)}`,
    `v2:sha256:${'A'.repeat(64)}`,
    `v2:sha256:${'a'.repeat(63)}`
  ])('fails closed for a malformed stored idempotency fingerprint: %s', async (fingerprint) => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-1`
    });
    const userId = 'wx-openid-a';
    await service.saveBodyProfile(userId, {
      expectedVersion: 0,
      idempotencyKey: 'profile-create-001',
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
    });
    replaceStoredFingerprint(
      database,
      `planning_user_states/${repository.documentIdForUser(userId)}`,
      fingerprint
    );

    await expect(repository.read(userId)).rejects.toBeInstanceOf(CorruptPlanningStateError);
  });

  test('fails closed when a stored version belongs to another user', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const service = createVersionedPlanningService({
      repository,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: () => 'profile-user-b'
    });
    await service.saveBodyProfile('wx-openid-b', {
      expectedVersion: 0,
      idempotencyKey: 'profile-user-b-create',
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
    });
    const userBDocument = database.documents.get(
      `planning_user_states/${repository.documentIdForUser('wx-openid-b')}`
    );
    database.documents.set(
      `planning_user_states/${repository.documentIdForUser('wx-openid-a')}`,
      structuredClone(userBDocument)
    );

    await expect(repository.read('wx-openid-a')).rejects.toBeInstanceOf(
      CorruptPlanningStateError
    );
  });

  test.each([1, 5])(
    'rejects schema version %s without attempting an implicit migration',
    async (schemaVersion) => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const documentId = repository.documentIdForUser('wx-openid-a');
    database.documents.set(`planning_user_states/${documentId}`, {
      schemaVersion,
      state: {}
    });

    await expect(repository.read('wx-openid-a')).rejects.toBeInstanceOf(
      CorruptPlanningStateError
    );
    }
  );

  test('validates semantic invariants before writing the next state', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);

    await expect(repository.transact('wx-openid-a', (state) => ({
      nextState: {
        ...state,
        activeBodyProfileVersionId: 'missing-profile'
      },
      result: undefined
    }))).rejects.toBeInstanceOf(CorruptPlanningStateError);
    expect(database.documents).toHaveLength(0);
  });
});
