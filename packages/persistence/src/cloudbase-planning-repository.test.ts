import { describe, expect, test, vi } from 'vitest';
import {
  createVersionedPlanningService,
  type PlanningRepository
} from '@fitness/application';
import {
  emptyAssistantConversationState,
  type PlanningAggregateState
} from '@fitness/domain';
import {
  CloudBasePlanningRepository,
  CorruptPlanningStateError,
  type CloudBaseDatabase,
  type CloudBaseDocumentReference,
  type CloudBaseTransaction
} from './cloudbase-planning-repository';
import { InMemoryPlanningRepository } from './in-memory-planning-repository';

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

  public remove(): Promise<unknown> {
    this.documents.delete(this.key);
    return Promise.resolve({ deleted: 1 });
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

function stateAtUtf8Bytes(
  empty: PlanningAggregateState,
  userId: string,
  targetBytes: number
): PlanningAggregateState {
  const profiles: PlanningAggregateState['bodyProfiles'][number][] = Array.from(
    { length: 15_000 },
    (_, index) => ({
      kind: 'body_profile_version' as const,
      id: `capacity-profile-${String(index + 1)}`,
      userId,
      version: index + 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      payload: {
        ageYears: 30,
        sexCode: 0 as const,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light' as const,
        allergens: [],
        avoidFoods: [],
        dietPreferences: [],
        businessTimezone: 'Asia/Shanghai'
      }
    })
  );
  const utf8Bytes = (state: PlanningAggregateState) => (
    new TextEncoder().encode(JSON.stringify(state)).byteLength
  );
  let low = 1;
  let high = profiles.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...empty, bodyProfiles: profiles.slice(0, middle) };
    if (utf8Bytes(candidate) <= targetBytes) low = middle;
    else high = middle - 1;
  }
  const selected = profiles.slice(0, low);
  const candidate = { ...empty, bodyProfiles: selected };
  const remaining = targetBytes - utf8Bytes(candidate);
  const last = selected.at(-1);
  if (last === undefined || remaining < 0) throw new Error('Capacity fixture is too small');
  const exact = {
    ...candidate,
    bodyProfiles: [
      ...selected.slice(0, -1),
      { ...last, id: `${last.id}${'x'.repeat(remaining)}` }
    ]
  };
  const exactBytes = utf8Bytes(exact);
  if (exactBytes !== targetBytes) {
    throw new Error(
      `Capacity fixture is not exact: expected ${String(targetBytes)}, got ${String(exactBytes)}, remaining ${String(remaining)}`
    );
  }
  return exact;
}

async function createPhase4State(repository: PlanningRepository): Promise<PlanningAggregateState> {
  let sequence = 0;
  const service = createVersionedPlanningService({
    repository,
    now: () => '2026-08-07T00:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  await service.completePlanningSetup('user-a', {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'phase4-repository-state-001',
    bodyProfile: {
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
    },
    goal: {
      goal: 'maintain',
      effectiveDate: '2026-08-07',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: '2026-08-10',
      businessTimezone: 'Asia/Shanghai',
      sessions: [{
        businessDate: '2026-08-11',
        sessionCode: '02054',
        durationMinutes: 60
      }]
    }
  });
  const state = await repository.read('user-a');
  const profile = state.bodyProfiles[0];
  const goal = state.goals[0];
  const trainingPlan = state.trainingPlans[0];
  const event = state.outboxEvents[0];
  const firstEnergyTarget = state.dailyEnergyTargets.find(
    (target) => target.businessDate === '2026-08-10'
  );
  const firstNutritionTarget = state.dailyNutritionTargets.find(
    (target) => target.businessDate === '2026-08-10'
  );
  if (
    profile === undefined
    || goal === undefined
    || trainingPlan === undefined
    || event === undefined
    || firstEnergyTarget === undefined
    || firstNutritionTarget === undefined
    || state.dailyNutritionTargets.length !== 7
  ) {
    throw new Error('Expected complete phase-4 repository fixture');
  }
  const nextEnergyTarget = {
    ...firstEnergyTarget,
    id: 'daily-energy-target-next',
    version: 2
  };
  const nextNutritionTarget = {
    ...firstNutritionTarget,
    id: 'daily-nutrition-target-next',
    version: 2,
    dailyEnergyTargetVersionId: nextEnergyTarget.id
  };
  const inventory = {
    kind: 'inventory_version' as const,
    id: 'inventory-1',
    userId: 'user-a',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    items: [{
      foodId: 'fixture-food',
      nutritionSnapshotId: 'snapshot-fixture-food-v1',
      availableGrams: 10_000
    }]
  };
  const targets = [...state.dailyNutritionTargets].sort((left, right) => (
    left.businessDate.localeCompare(right.businessDate)
  ));
  const completePlan = {
    kind: 'meal_plan_version' as const,
    id: 'meal-plan-1',
    userId: 'user-a',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    weekStartDate: trainingPlan.payload.weekStartDate,
    bodyProfileVersionId: profile.id,
    goalVersionId: goal.id,
    trainingPlanVersionId: trainingPlan.id,
    inventoryVersionId: inventory.id,
    catalogVersionId: 'catalog-fixture-v1',
    generationPolicyVersion: 'weekly-meal-generation-v1' as const,
    supersedesVersionId: null,
    readiness: 'complete' as const,
    days: targets.map((target) => ({
      businessDate: target.businessDate,
      dailyNutritionTargetVersionId: target.id,
      dailyMenuTemplateVersionId: `menu-${target.businessDate}`,
      locked: target.businessDate === nextNutritionTarget.businessDate,
      manuallyModified: false,
      meals: [{
        slot: 'breakfast' as const,
        recipeTemplateVersionId: 'recipe-fixture-v1',
        servingMultiplier: 1
      }],
      ingredientAmounts: [{ foodId: 'fixture-food', grams: 100 }],
      nutritionTotals: {
        energyKcal: 100,
        proteinG: 10,
        fatG: 5,
        carbohydrateG: 12,
        fiberG: 3,
        saturatedFatG: 1,
        addedSugarG: 0
      },
      nutritionSourceSnapshotIds: ['snapshot-fixture-food-v1']
    }))
  };
  const candidatePlan = {
    ...completePlan,
    id: 'meal-plan-2',
    version: 2,
    supersedesVersionId: completePlan.id,
    readiness: 'pending_confirmation' as const,
    days: completePlan.days.map((day) => (
      day.businessDate === nextNutritionTarget.businessDate
        ? {
            ...day,
            dailyNutritionTargetVersionId: nextNutritionTarget.id,
            locked: true
          }
        : day
    ))
  };
  const diff = {
    id: 'meal-diff-1',
    userId: 'user-a',
    candidateMealPlanVersionId: candidatePlan.id,
    businessDate: nextNutritionTarget.businessDate,
    previousNutritionTargetVersionId: firstNutritionTarget.id,
    proposedNutritionTargetVersionId: nextNutritionTarget.id,
    reason: 'locked_or_manually_modified' as const
  };
  const linkedEvent = {
    ...event,
    affectedDates: [nextNutritionTarget.businessDate]
  };
  const nextState: PlanningAggregateState = {
    ...state,
    outboxEvents: [linkedEvent],
    dailyEnergyTargets: [...state.dailyEnergyTargets, nextEnergyTarget],
    dailyNutritionTargets: [...state.dailyNutritionTargets, nextNutritionTarget],
    inventories: [inventory],
    mealPlans: [completePlan, candidatePlan],
    mealPlanTargetDiffs: [diff],
    recalculationJobs: [{
      kind: 'recalculation_job',
      id: 'recalculation-job-candidate',
      userId: 'user-a',
      triggerEventId: linkedEvent.eventId,
      triggerType: 'training_plan_changed',
      affectedDates: linkedEvent.affectedDates,
      status: 'pending',
      createdAt: '2026-08-10T01:00:00.000Z',
      completedAt: null,
      candidateMealPlanVersionId: candidatePlan.id,
      activatedMealPlanVersionId: null,
      failureCode: null,
      failureConflictDetailsStatus: 'complete',
      failureConflicts: []
    }],
    activeInventoryVersionId: inventory.id,
    activeMealPlanVersionId: completePlan.id
  };
  await repository.transact('user-a', () => ({ nextState, result: undefined }));
  return repository.read('user-a');
}

function corruptPhase4State(
  state: PlanningAggregateState,
  corruption: 'cross_user' | 'dangling' | 'duplicate_trigger' | 'pending_active'
): PlanningAggregateState {
  if (corruption === 'cross_user') {
    return {
      ...state,
      inventories: state.inventories.map((inventory) => ({
        ...inventory,
        userId: 'user-b'
      }))
    };
  }
  if (corruption === 'dangling') {
    return { ...state, activeInventoryVersionId: 'missing-inventory' };
  }
  if (corruption === 'pending_active') {
    const candidate = state.mealPlans.find((plan) => plan.readiness === 'pending_confirmation');
    if (candidate === undefined) throw new Error('Expected pending candidate');
    return { ...state, activeMealPlanVersionId: candidate.id };
  }
  const event = state.outboxEvents[0];
  if (event === undefined) throw new Error('Expected trigger event');
  const job = {
    kind: 'recalculation_job' as const,
    id: 'recalculation-job-1',
    userId: 'user-a',
    triggerEventId: event.eventId,
    triggerType: 'training_plan_changed' as const,
    affectedDates: event.affectedDates,
    status: 'pending' as const,
    createdAt: '2026-08-10T01:00:00.000Z',
    completedAt: null,
    candidateMealPlanVersionId: null,
    activatedMealPlanVersionId: null,
    failureCode: null,
    failureConflictDetailsStatus: 'complete' as const,
    failureConflicts: []
  };
  return {
    ...state,
    recalculationJobs: [job, { ...job, id: 'recalculation-job-2' }]
  };
}

describe('CloudBasePlanningRepository', () => {
  test('accepts exactly 3,000,000 aggregate bytes and rejects one more before writing', async () => {
    const aggregateLimitBytes = 3_000_000;
    const acceptedDatabase = new FakeDatabase();
    const acceptedRepository = new CloudBasePlanningRepository(acceptedDatabase);
    const empty = await acceptedRepository.read('user-a');
    const exact = stateAtUtf8Bytes(
      empty,
      'user-a',
      aggregateLimitBytes
    );

    await expect(acceptedRepository.transact('user-a', () => ({
      nextState: exact,
      result: undefined
    }))).resolves.toBeUndefined();
    expect(acceptedDatabase.documents).toHaveLength(1);

    const rejectedDatabase = new FakeDatabase();
    const rejectedRepository = new CloudBasePlanningRepository(rejectedDatabase);
    const last = exact.bodyProfiles.at(-1);
    if (last === undefined) throw new Error('Expected capacity profile fixture');
    const over = {
      ...exact,
      bodyProfiles: [
        ...exact.bodyProfiles.slice(0, -1),
        { ...last, id: `${last.id}x` }
      ]
    };

    await expect(rejectedRepository.transact('user-a', () => ({
      nextState: over,
      result: undefined
    }))).rejects.toMatchObject({ code: 'account_capacity_exceeded' });
    expect(rejectedDatabase.documents).toHaveLength(0);
  });

  test('migrates schema v7 to an explicit empty account-deletion state without mutating on read', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const state = await createPhase4State(new InMemoryPlanningRepository());
    const documentKey = `planning_user_states/${repository.documentIdForUser('user-a')}`;
    const legacyState = structuredClone(state) as unknown as Record<string, unknown>;
    delete legacyState.accountDeletion;
    const stored = { schemaVersion: 7, state: legacyState };
    const before = structuredClone(stored);
    database.documents.set(documentKey, stored);

    const migrated = await repository.read('user-a');

    expect((migrated as unknown as Record<string, unknown>).accountDeletion).toBeNull();
    expect(database.documents.get(documentKey)).toEqual(before);
    await repository.transact('user-a', (current) => ({
      nextState: current,
      result: undefined
    }));
    expect(database.documents.get(documentKey)).toMatchObject({ schemaVersion: 8 });
  });

  test('round-trips a bounded schema-v8 pending account deletion', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const accountDeletion = {
      status: 'pending' as const,
      idempotencyKey: 'delete-account-0001',
      requestFingerprint: `v2:sha256:${'a'.repeat(64)}`,
      snapshotToken: 'snapshot-token-0001',
      requestedAt: '2026-08-20T00:00:00.000Z',
      privateFileIds: [
        'cloud://env.bucket/ingredient-photos/photo-a/upload.jpg',
        'cloud://env.bucket/ingredient-photos/photo-b/upload.jpg'
      ]
    };
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        accountDeletion
      },
      result: undefined
    }));

    const restored = await new CloudBasePlanningRepository(database).read('user-a');
    const stored = database.documents.get(
      `planning_user_states/${repository.documentIdForUser('user-a')}`
    );

    expect((restored as unknown as Record<string, unknown>).accountDeletion)
      .toEqual(accountDeletion);
    expect(stored).toMatchObject({ schemaVersion: 8 });
  });

  test('distinguishes missing privileged reads and atomically deletes an existing document', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database) as CloudBasePlanningRepository & {
      readExisting(userId: string): Promise<PlanningAggregateState | null>;
      deleteExisting<TResult>(
        userId: string,
        operation: (current: PlanningAggregateState) => TResult
      ): Promise<TResult>;
    };

    await expect(repository.readExisting('user-a')).resolves.toBeNull();
    await repository.transact('user-a', (state) => ({ nextState: state, result: undefined }));
    await expect(repository.deleteExisting('user-a', (current) => (
      current.bodyProfiles.length
    ))).resolves.toBe(0);
    await expect(repository.readExisting('user-a')).resolves.toBeNull();
    await expect(repository.deleteExisting('user-a', () => undefined)).rejects.toMatchObject({
      code: 'personal_data_document_not_found'
    });
  });

  test('migrates schema v6 to an empty assistant conversation without inventing history', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const state = await createPhase4State(new InMemoryPlanningRepository());
    const documentKey = `planning_user_states/${repository.documentIdForUser('user-a')}`;
    const legacyState = structuredClone(state) as unknown as Record<string, unknown>;
    delete legacyState.assistantConversation;
    const stored = { schemaVersion: 6, state: legacyState };
    const before = structuredClone(stored);
    database.documents.set(documentKey, stored);

    const migrated = await repository.read('user-a');

    expect(migrated.assistantConversation).toEqual(emptyAssistantConversationState());
    expect(database.documents.get(documentKey)).toEqual(before);
    await repository.transact('user-a', (current) => ({
      nextState: current,
      result: undefined
    }));
    expect(database.documents.get(documentKey)).toMatchObject({ schemaVersion: 8 });
  });

  test('round-trips a bounded schema-v8 assistant conversation', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const conversation: PlanningAggregateState['assistantConversation'] = {
      version: 1,
      recentMessages: [{
        turnId: 'assistant-turn-0001',
        role: 'user',
        content: '把训练移到明天',
        createdAt: '2026-08-20T00:00:00.000Z'
      }, {
        turnId: 'assistant-turn-0001',
        role: 'assistant',
        content: '请使用 YYYY-MM-DD 补充原日期和目标日期。',
        createdAt: '2026-08-20T00:00:01.000Z'
      }],
      summary: {
        activeWeekStartDate: null,
        trainingPlanVersion: 0,
        mealPlanVersion: 0,
        lockedMealDates: [],
        pendingClarification: null
      },
      pendingTurn: null,
      recentReceipts: [{
        turnId: 'assistant-turn-0001',
        idempotencyKey: 'assistant-request-0001',
        requestFingerprint: `v2:sha256:${'d'.repeat(64)}`,
        conversationVersion: 1,
        completedAt: '2026-08-20T00:00:01.000Z',
        result: {
          kind: 'request_rejected',
          reason: 'unsupported_request',
          message: '仅支持移动训练日、换菜和调整份量。'
        }
      }]
    };
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        assistantConversation: conversation
      },
      result: undefined
    }));

    const restored = await new CloudBasePlanningRepository(database).read('user-a');

    expect(restored.assistantConversation).toEqual(conversation);
  });

  test('migrates schema v5 without inventing photo facts', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const phase4State = await createPhase4State(new InMemoryPlanningRepository());
    const key = `planning_user_states/${repository.documentIdForUser('user-a')}`;
    const legacyState = structuredClone(phase4State) as unknown as Record<string, unknown>;
    delete legacyState.ingredientPhotoVersions;
    delete legacyState.nextPhotoCleanupAt;
    database.documents.set(key, { schemaVersion: 5, state: legacyState });

    const migrated = await repository.read('user-a');

    expect(migrated.ingredientPhotoVersions).toEqual([]);
    expect(migrated.nextPhotoCleanupAt).toBeNull();
  });

  test('migrates v4 nutrition failures to explicit legacy-unavailable details without mutating on read', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const phase4State = await createPhase4State(repository);
    const documentKey = `planning_user_states/${repository.documentIdForUser('user-a')}`;
    const stored = database.documents.get(documentKey);
    const job = phase4State.recalculationJobs[0];
    const activePlan = phase4State.mealPlans.find(
      (plan) => plan.id === phase4State.activeMealPlanVersionId
    );
    if (job === undefined || activePlan === undefined || !isRecord(stored)) {
      throw new Error('Expected stored v4 migration fixture');
    }
    const legacyDocument = {
      schemaVersion: 4,
      state: {
        ...phase4State,
        mealPlans: [activePlan],
        mealPlanTargetDiffs: [],
        recalculationJobs: [{
          kind: job.kind,
          id: job.id,
          userId: job.userId,
          triggerEventId: job.triggerEventId,
          triggerType: job.triggerType,
          affectedDates: job.affectedDates,
          status: 'failed_retryable',
          createdAt: job.createdAt,
          completedAt: null,
          candidateMealPlanVersionId: null,
          activatedMealPlanVersionId: null,
          failureCode: 'nutrition_constraints_infeasible'
        }]
      }
    };
    database.documents.set(documentKey, legacyDocument);

    const migrated = await repository.read('user-a');

    expect(migrated.recalculationJobs[0]).toMatchObject({
      failureConflictDetailsStatus: 'legacy_unavailable',
      failureConflicts: []
    });
    expect(database.documents.get(documentKey)).toEqual(legacyDocument);
    await repository.transact('user-a', (state) => ({ nextState: state, result: undefined }));
    expect(database.documents.get(documentKey)).toMatchObject({ schemaVersion: 8 });
  });

  test.each([
    'cross_user',
    'dangling',
    'duplicate_trigger',
    'pending_active'
  ] as const)(
    'rejects %s corruption consistently in memory and CloudBase',
    async (corruption) => {
      const repositories: readonly PlanningRepository[] = [
        new InMemoryPlanningRepository(),
        new CloudBasePlanningRepository(new FakeDatabase())
      ];
      for (const repository of repositories) {
        const state = await createPhase4State(repository);
        await expect(repository.transact('user-a', () => ({
          nextState: corruptPhase4State(state, corruption),
          result: undefined
        }))).rejects.toBeInstanceOf(CorruptPlanningStateError);
        await expect(repository.read('user-a')).resolves.toEqual(state);
      }
    }
  );

  test('initializes missing state without the Node 17 structuredClone global', async () => {
    vi.stubGlobal('structuredClone', undefined);
    try {
      const repository = new CloudBasePlanningRepository(new FakeDatabase());

      await expect(repository.read('wx-openid-a')).resolves.toMatchObject({
        accountDeletion: null,
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
      schemaVersion: 8
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
    expect(isRecord(migrated) ? migrated.schemaVersion : undefined).toBe(8);
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

  test.each([1, 9])(
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
