import { describe, expect, test } from 'vitest';
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
    this.documents.set(this.key, structuredClone(input.data));
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

describe('CloudBasePlanningRepository', () => {
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
  });

  test('fails closed instead of replacing a corrupt stored state', async () => {
    const database = new FakeDatabase();
    const repository = new CloudBasePlanningRepository(database);
    const documentId = repository.documentIdForUser('wx-openid-a');
    database.documents.set(`planning_user_states/${documentId}`, {
      schemaVersion: 1,
      state: { bodyProfiles: 'not-an-array' }
    });

    await expect(repository.read('wx-openid-a')).rejects.toBeInstanceOf(
      CorruptPlanningStateError
    );
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
});
