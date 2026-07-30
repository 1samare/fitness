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
});
