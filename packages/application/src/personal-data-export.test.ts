import { describe, expect, test, vi } from 'vitest';
import {
  deriveNextPhotoCleanupAt,
  type IngredientPhotoVersion,
  type PlanningAggregateState,
  type PrivatePhotoStorage
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { createVersionedPlanningService } from './versioned-planning';
import { createPersonalDataService } from './personal-data';
import { computePersonalDataSnapshotToken } from './personal-data-export';

const banned = /^(userId|openid|_id|expectedCloudPath|expectedPrivateFileId|privateFileId|providerRequestId|idempotencyRecords|accountDeletion|requestFingerprint|nextPhotoCleanupAt)$/i;

function assertNoBannedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoBannedKeys);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(banned);
    assertNoBannedKeys(child);
  }
}

function photoVersions(userId: string): readonly IngredientPhotoVersion[] {
  const base: IngredientPhotoVersion = {
    kind: 'ingredient_photo_version',
    id: 'photo-version-1',
    photoId: 'photo-1',
    userId,
    revision: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    uploadCreatedAt: '2026-08-20T00:00:00.000Z',
    deleteDueAt: '2026-08-20T23:00:00.000Z',
    expectedCloudPath: 'ingredient-photos/photo-1/upload.jpg',
    expectedPrivateFileId: 'cloud://env.bucket/ingredient-photos/photo-1/upload.jpg',
    mediaType: 'image/jpeg',
    workflowStatus: 'awaiting_upload',
    storageStatus: 'retained',
    candidates: [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: '2026-08-20T23:00:00.000Z',
    lastCleanupFailureCode: null,
    deletedAt: null
  };
  const uploaded: IngredientPhotoVersion = {
    ...base,
    id: 'photo-version-2',
    revision: 2,
    createdAt: '2026-08-20T00:01:00.000Z',
    workflowStatus: 'uploaded'
  };
  return [base, uploaded, {
    ...uploaded,
    id: 'photo-version-3',
    revision: 3,
    createdAt: '2026-08-20T00:02:00.000Z',
    workflowStatus: 'recognized',
    candidates: [{
      id: 'candidate-internal-1',
      foodId: 'food-internal-1',
      nutritionSnapshotId: 'snapshot-reviewed-1',
      canonicalNameZh: '西兰花',
      confidence: 0.93,
      foodState: 'raw'
    }]
  }];
}

async function createRichState(): Promise<{
  readonly repository: InMemoryPlanningRepository;
  readonly state: PlanningAggregateState;
}> {
  const repository = new InMemoryPlanningRepository();
  let sequence = 0;
  const planning = createVersionedPlanningService({
    repository,
    now: () => '2026-08-20T00:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`
  });
  await planning.completePlanningSetup('user-a', {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: 'personal-export-setup-001',
    bodyProfile: {
      ageYears: 30,
      sexCode: 0,
      heightCm: 175,
      weightKg: 70,
      healthScopeConfirmed: true,
      nonTrainingActivity: 'light',
      allergens: ['花生'],
      avoidFoods: ['香菜'],
      dietPreferences: ['家常菜'],
      businessTimezone: 'Asia/Shanghai'
    },
    goal: {
      goal: 'maintain',
      effectiveDate: '2026-08-20',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: '2026-08-17',
      businessTimezone: 'Asia/Shanghai',
      sessions: [{
        businessDate: '2026-08-21',
        sessionCode: '02054',
        durationMinutes: 60
      }]
    }
  });
  const photos = photoVersions('user-a');
  await repository.transact('user-a', (state) => ({
    nextState: {
      ...state,
      assistantConversation: {
        ...state.assistantConversation,
        version: 1,
        recentMessages: [{
          turnId: 'assistant-turn-1',
          role: 'user',
          content: '把训练移到周五',
          createdAt: '2026-08-20T00:03:00.000Z'
        }, {
          turnId: 'assistant-turn-1',
          role: 'assistant',
          content: '已记录你的调整请求。',
          createdAt: '2026-08-20T00:03:01.000Z'
        }]
      },
      ingredientPhotoVersions: photos,
      nextPhotoCleanupAt: deriveNextPhotoCleanupAt(photos)
    },
    result: undefined
  }));
  return { repository, state: await repository.read('user-a') };
}

describe('personal data export', () => {
  test('creates a stable canonical SHA-256 token and excludes deletion state', async () => {
    const { state } = await createRichState();
    const token = computePersonalDataSnapshotToken(state);
    const reordered = Object.fromEntries(
      Object.entries(state).reverse()
    ) as unknown as PlanningAggregateState;
    const withPendingDeletion = {
      ...state,
      accountDeletion: {
        status: 'pending' as const,
        idempotencyKey: 'delete-account-001',
        requestFingerprint: `v2:sha256:${'b'.repeat(64)}`,
        snapshotToken: token,
        requestedAt: '2026-08-20T01:00:00.000Z',
        privateFileIds: []
      }
    };

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(computePersonalDataSnapshotToken(reordered)).toBe(token);
    expect(computePersonalDataSnapshotToken(withPendingDeletion)).toBe(token);
    expect(computePersonalDataSnapshotToken({
      ...state,
      bodyProfiles: state.bodyProfiles.map((profile) => ({
        ...profile,
        payload: { ...profile.payload, weightKg: profile.payload.weightKg + 0.1 }
      }))
    })).not.toBe(token);
  });

  test('exports only explicit public user-facing records and sorted provenance', async () => {
    const { repository } = await createRichState();
    const storage: PrivatePhotoStorage = {
      inspectPrivateFile: vi.fn(() => Promise.reject(new Error('unused'))),
      deletePrivateFile: vi.fn(() => Promise.resolve('deleted' as const))
    };
    const service = createPersonalDataService({
      repository,
      storage,
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const summary = await service.getPersonalDataSummary('user-a');
    if (summary.snapshotToken === null) throw new Error('Expected personal data');

    const exported = await service.exportPersonalData('user-a', summary.snapshotToken);

    assertNoBannedKeys(exported);
    expect(JSON.stringify(exported)).not.toContain('user-a');
    expect(JSON.stringify(exported)).not.toContain('cloud://');
    expect(JSON.stringify(exported)).not.toContain('ingredient-photos/photo-1/upload.jpg');
    expect(exported.notice).toContain('AI 辅助生成内容');
    expect(new Set(exported.records.map((record) => record.contentOrigin)))
      .toEqual(new Set(['user', 'ai_assisted', 'deterministic']));
    expect(exported.records.map((record) => record.category)).toEqual(expect.arrayContaining([
      'body_profile',
      'fitness_goal',
      'training_plan',
      'daily_energy_target',
      'daily_nutrition_target',
      'ingredient_photo_confirmation',
      'assistant_message'
    ]));
    expect(exported.provenance.policyVersions).toEqual(
      [...exported.provenance.policyVersions].sort()
    );
    expect(exported.provenance.reviewedDataVersionReferences).toEqual(
      [...exported.provenance.reviewedDataVersionReferences].sort()
    );

    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        assistantConversation: {
          ...state.assistantConversation,
          version: 2,
          recentMessages: [...state.assistantConversation.recentMessages, {
            turnId: 'assistant-turn-2',
            role: 'user',
            content: '再增加一天训练',
            createdAt: '2026-08-20T02:01:00.000Z'
          }]
        }
      },
      result: undefined
    }));
    await expect(service.exportPersonalData('user-a', summary.snapshotToken)).rejects.toMatchObject({
      code: 'personal_data_snapshot_conflict'
    });
  });
});
