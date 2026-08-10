import { describe, expect, test } from 'vitest';
import type {
  CloudBaseDatabase,
  CloudBaseDocumentReference,
  CloudBaseTransaction
} from '@fitness/persistence';
import { createRuntimePlanningHandler } from './runtime-handler';

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
    this.documents.set(this.key, structuredClone(input.data));
    return Promise.resolve({ updated: 1 });
  }
}

class FakeDatabase implements CloudBaseDatabase, CloudBaseTransaction {
  private readonly documents = new Map<string, unknown>();
  public collection(name: string) {
    return {
      doc: (id: string) => new FakeDocumentReference(this.documents, `${name}/${id}`)
    };
  }
  public runTransaction<TResult>(
    operation: (transaction: CloudBaseTransaction) => Promise<TResult>
  ): Promise<TResult> {
    return operation(this);
  }
}

const writeProfile = {
  action: 'saveBodyProfile',
  payload: {
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
  }
} as const;

const completeSetup = {
  action: 'completePlanningSetup',
  payload: {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'planning-setup-001',
    bodyProfile: writeProfile.payload.payload,
    goal: {
      goal: 'maintain',
      effectiveDate: '2026-08-07',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: '2026-08-10',
      businessTimezone: 'Asia/Shanghai',
      sessions: []
    }
  }
} as const;

describe('runtime planning handler', () => {
  test('uses CloudBase persistence in cloud mode across cold starts', async () => {
    const database = new FakeDatabase();
    const first = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: () => 'profile-1'
    });
    await first(writeProfile, { userId: 'wx-openid-a' });

    const afterColdStart = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      now: () => '2026-08-03T08:00:00.000Z',
      nextId: () => 'unused'
    });
    const result = await afterColdStart(
      { action: 'getCurrentContext' },
      { userId: 'wx-openid-a' }
    );

    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'current_context') {
      expect(result.data.bodyProfile?.id).toBe('profile-1');
    }
  });

  test('persists one atomic setup across cloud handler cold starts', async () => {
    const database = new FakeDatabase();
    let sequence = 0;
    const first = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      now: () => '2026-08-07T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    });
    const saved = await first(completeSetup, { userId: 'wx-openid-setup' });
    expect(saved.success).toBe(true);

    const afterColdStart = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      now: () => '2026-08-07T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-unused`
    });
    const current = await afterColdStart(
      { action: 'getCurrentContext' },
      { userId: 'wx-openid-setup' }
    );
    expect(current.success).toBe(true);
    if (current.success && current.data.kind === 'current_context') {
      expect(current.data.latestVersions).toEqual({
        bodyProfile: 1,
        goal: 1,
        trainingPlan: 1,
        inventory: 0,
        mealPlan: 0,
        mealPlanDecision: 0,
        trainingCompletion: 0
      });
      expect(current.data.dailyEnergyTargets).toHaveLength(7);
    }
  });

  test('loads fixture providers only in local mode and fails closed in cloud mode', async () => {
    const local = createRuntimePlanningHandler({ runtimeMode: 'local' });
    const localResolution = await local({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    }, { userId: 'local-user' });
    expect(localResolution.success).toBe(true);
    if (localResolution.success && localResolution.data.kind === 'food_name_resolved') {
      expect(localResolution.data.resolution?.foodId).toBe('fixture-rice');
    }

    const cloud = createRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase()
    });
    const cloudResolution = await cloud({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    }, { userId: 'cloud-user' });
    expect(cloudResolution).toEqual({
      success: false,
      error: {
        code: 'provider_unavailable',
        message: '营养数据暂时不可用。'
      }
    });
  });
});
