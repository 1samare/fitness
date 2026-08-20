import { describe, expect, test, vi } from 'vitest';
import {
  deriveNextPhotoCleanupAt,
  type IngredientPhotoVersion,
  type PlanningAggregateState,
  type PrivatePhotoStorage
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import type { PersonalDataRepository } from './personal-data-repository';
import { StorageUnavailableError } from './ingredient-photo';
import { createVersionedPlanningService } from './versioned-planning';
import { createPersonalDataService, type DeleteAccountCommand } from './personal-data';

function photo(
  userId: string,
  photoId: string,
  privateFileId: string,
  revision = 1
): IngredientPhotoVersion {
  return {
    kind: 'ingredient_photo_version',
    id: `${photoId}-version-${String(revision)}`,
    photoId,
    userId,
    revision,
    createdAt: `2026-08-20T00:0${String(revision)}:00.000Z`,
    uploadCreatedAt: '2026-08-20T00:00:00.000Z',
    deleteDueAt: '2026-08-20T23:00:00.000Z',
    expectedCloudPath: `ingredient-photos/${photoId}/upload.jpg`,
    expectedPrivateFileId: privateFileId,
    mediaType: 'image/jpeg',
    workflowStatus: revision === 1 ? 'awaiting_upload' : 'uploaded',
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
}

async function seedAccount(
  repository: InMemoryPlanningRepository,
  userId = 'user-a',
  createdAt = '2026-08-20T00:00:00.000Z',
  idSuffix = 'first'
): Promise<void> {
  let sequence = 0;
  const planning = createVersionedPlanningService({
    repository,
    now: () => createdAt,
    nextId: (prefix) => `${prefix}-${idSuffix}-${String(++sequence)}`
  });
  await planning.completePlanningSetup(userId, {
    expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
    idempotencyKey: `personal-data-setup-${idSuffix}`,
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
      effectiveDate: '2026-08-20',
      targetDate: '2026-10-30'
    },
    trainingPlan: {
      weekStartDate: '2026-08-17',
      businessTimezone: 'Asia/Shanghai',
      sessions: []
    }
  });
}

async function addPhotos(
  repository: InMemoryPlanningRepository,
  userId: string,
  photos: readonly IngredientPhotoVersion[]
): Promise<void> {
  await repository.transact(userId, (state) => ({
    nextState: {
      ...state,
      ingredientPhotoVersions: photos,
      nextPhotoCleanupAt: deriveNextPhotoCleanupAt(photos)
    },
    result: undefined
  }));
}

function storageWith(
  deletePrivateFile: PrivatePhotoStorage['deletePrivateFile']
): PrivatePhotoStorage {
  return {
    inspectPrivateFile: vi.fn(() => Promise.reject(new Error('unused'))),
    deletePrivateFile
  };
}

function wrapRepository(
  raw: InMemoryPlanningRepository,
  deleteExisting: PersonalDataRepository['deleteExisting']
): PersonalDataRepository {
  return {
    read: (userId) => raw.read(userId),
    readExisting: (userId) => raw.readExisting(userId),
    transact: (userId, operation) => raw.transact(userId, operation),
    deleteExisting
  };
}

describe('personal data service', () => {
  test('returns safe absent, pending, and oversized summaries and rejects stale export', async () => {
    const repository = new InMemoryPlanningRepository();
    const service = createPersonalDataService({
      repository,
      storage: storageWith(() => Promise.resolve('deleted')),
      now: () => '2026-08-20T02:00:00.000Z'
    });

    await expect(service.getPersonalDataSummary('missing')).resolves.toEqual({
      kind: 'personal_data_summary',
      dataExists: false,
      snapshotToken: null,
      deletionStatus: 'none',
      capacityStatus: 'within_limit',
      activeVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0, inventory: 0, mealPlan: 0 },
      counts: {
        bodyProfileVersions: 0,
        goalVersions: 0,
        trainingPlanVersions: 0,
        dailyTargetVersions: 0,
        inventoryVersions: 0,
        mealPlanVersions: 0,
        ingredientPhotoRecords: 0,
        assistantMessages: 0
      }
    });

    await seedAccount(repository);
    const initial = await service.getPersonalDataSummary('user-a');
    const initialToken = initial.snapshotToken;
    if (initialToken === null) throw new Error('Expected account snapshot');
    await repository.transact('user-a', (state) => ({
      nextState: {
        ...state,
        accountDeletion: {
          status: 'pending',
          idempotencyKey: 'delete-account-001',
          requestFingerprint: `v2:sha256:${'c'.repeat(64)}`,
          snapshotToken: initialToken,
          requestedAt: '2026-08-20T02:00:00.000Z',
          privateFileIds: []
        }
      },
      result: undefined
    }));
    const pending = await service.getPersonalDataSummary('user-a');
    expect(pending).toMatchObject({
      dataExists: true,
      deletionStatus: 'pending',
      snapshotToken: initialToken
    });
    expect(JSON.stringify(pending)).not.toContain('delete-account-001');
    await expect(service.exportPersonalData('user-a', initialToken)).rejects.toMatchObject({
      code: 'account_deletion_pending'
    });

    const retained = await repository.readExisting('user-a');
    if (retained === null) throw new Error('Expected retained account');
    const oversized = {
      ...retained,
      accountDeletion: null,
      assistantConversation: {
        ...retained.assistantConversation,
        recentMessages: [{
          turnId: 'legacy-large-turn',
          role: 'user' as const,
          content: 'a'.repeat(3_000_000),
          createdAt: '2026-08-20T00:00:00.000Z'
        }]
      }
    } satisfies PlanningAggregateState;
    const legacyRepository = wrapRepository(
      repository,
      (userId, operation) => repository.deleteExisting(userId, operation)
    );
    const oversizedService = createPersonalDataService({
      repository: {
        ...legacyRepository,
        readExisting: () => Promise.resolve(oversized)
      },
      storage: storageWith(() => Promise.resolve('deleted')),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    await expect(oversizedService.getPersonalDataSummary('user-a')).resolves.toMatchObject({
      capacityStatus: 'admin_recovery_required'
    });
    await expect(oversizedService.exportPersonalData(
      'user-a',
      initialToken
    )).rejects.toMatchObject({ code: 'account_capacity_exceeded' });

    let legacyState: PlanningAggregateState | null = oversized;
    const legacyDeletionRepository: PersonalDataRepository = {
      read: () => Promise.resolve(legacyState ?? oversized),
      readExisting: () => Promise.resolve(legacyState),
      transact: (_userId, operation) => {
        if (legacyState === null) return Promise.reject(new Error('missing legacy state'));
        const { nextState, result } = operation(legacyState);
        legacyState = nextState;
        return Promise.resolve(result);
      },
      deleteExisting: (_userId, operation) => {
        if (legacyState === null) return Promise.reject(new Error('missing legacy state'));
        const result = operation(legacyState);
        legacyState = null;
        return Promise.resolve(result);
      }
    };
    const legacyDeletionService = createPersonalDataService({
      repository: legacyDeletionRepository,
      storage: storageWith(() => Promise.resolve('deleted')),
      now: () => '2026-08-20T03:00:00.000Z'
    });
    const legacySummary = await legacyDeletionService.getPersonalDataSummary('user-a');
    if (legacySummary.snapshotToken === null) throw new Error('Expected legacy snapshot');
    await expect(legacyDeletionService.deleteAccount('user-a', {
      snapshotToken: legacySummary.snapshotToken,
      idempotencyKey: 'delete-account-legacy-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    })).resolves.toMatchObject({ kind: 'account_deleted' });
    expect(legacyState).toBeNull();
  });

  test('rejects a stale snapshot before mutating the account', async () => {
    const repository = new InMemoryPlanningRepository();
    await seedAccount(repository);
    const deletePrivateFile = vi.fn(() => Promise.resolve('deleted' as const));
    const service = createPersonalDataService({
      repository,
      storage: storageWith(deletePrivateFile),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const before = await repository.readExisting('user-a');

    await expect(service.deleteAccount('user-a', {
      snapshotToken: '0'.repeat(64),
      idempotencyKey: 'delete-account-stale-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    })).rejects.toMatchObject({ code: 'personal_data_snapshot_conflict' });

    expect(await repository.readExisting('user-a')).toEqual(before);
    expect(deletePrivateFile).not.toHaveBeenCalled();
  });

  test('deduplicates private files and accepts not-found deletion outcomes', async () => {
    const repository = new InMemoryPlanningRepository();
    await seedAccount(repository);
    const fileId = 'cloud://env.bucket/ingredient-photos/photo-1/upload.jpg';
    await addPhotos(repository, 'user-a', [
      photo('user-a', 'photo-1', fileId, 1),
      photo('user-a', 'photo-1', fileId, 2)
    ]);
    const deletePrivateFile = vi.fn(() => Promise.resolve('not_found' as const));
    const service = createPersonalDataService({
      repository,
      storage: storageWith(deletePrivateFile),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const summary = await service.getPersonalDataSummary('user-a');
    if (summary.snapshotToken === null) throw new Error('Expected account snapshot');

    await expect(service.deleteAccount('user-a', {
      snapshotToken: summary.snapshotToken,
      idempotencyKey: 'delete-account-files-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    })).resolves.toEqual({
      kind: 'account_deleted',
      deletedPrivateFileCount: 0
    });
    expect(deletePrivateFile).toHaveBeenCalledTimes(1);
    expect(deletePrivateFile).toHaveBeenCalledWith({ privateFileId: fileId });
  });

  test('retains all data after storage failure and only the exact command retry can finish', async () => {
    const repository = new InMemoryPlanningRepository();
    await seedAccount(repository);
    const firstFile = 'cloud://env.bucket/ingredient-photos/photo-1/upload.jpg';
    const secondFile = 'cloud://env.bucket/ingredient-photos/photo-2/upload.jpg';
    await addPhotos(repository, 'user-a', [
      photo('user-a', 'photo-1', firstFile),
      photo('user-a', 'photo-2', secondFile)
    ]);
    const deletePrivateFile = vi.fn()
      .mockResolvedValueOnce('deleted')
      .mockRejectedValueOnce(new StorageUnavailableError());
    const service = createPersonalDataService({
      repository,
      storage: storageWith(deletePrivateFile),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const summary = await service.getPersonalDataSummary('user-a');
    if (summary.snapshotToken === null) throw new Error('Expected account snapshot');
    const command: DeleteAccountCommand = {
      snapshotToken: summary.snapshotToken,
      idempotencyKey: 'delete-account-retry-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    };

    await expect(service.deleteAccount('user-a', command)).rejects.toMatchObject({
      code: 'storage_unavailable'
    });
    const retained = await repository.readExisting('user-a');
    expect(retained).toMatchObject({ accountDeletion: { status: 'pending' } });
    expect(retained?.bodyProfiles).toHaveLength(1);
    await expect(service.exportPersonalData('user-a', summary.snapshotToken)).rejects.toMatchObject({
      code: 'account_deletion_pending'
    });
    await expect(service.deleteAccount('user-a', {
      ...command,
      snapshotToken: '1'.repeat(64)
    })).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await expect(service.deleteAccount('user-a', {
      ...command,
      idempotencyKey: 'delete-account-other-001'
    })).rejects.toMatchObject({ code: 'account_deletion_pending' });

    deletePrivateFile.mockResolvedValue('deleted');
    await expect(service.deleteAccount('user-a', command)).resolves.toMatchObject({
      kind: 'account_deleted'
    });
    await expect(repository.readExisting('user-a')).resolves.toBeNull();
  });

  test('retries a database removal failure and treats response loss as already absent', async () => {
    const rawFailure = new InMemoryPlanningRepository();
    await seedAccount(rawFailure);
    let failBeforeDelete = true;
    const failureRepository = wrapRepository(rawFailure, async (userId, operation) => {
      if (failBeforeDelete) {
        failBeforeDelete = false;
        throw new Error('database unavailable');
      }
      return rawFailure.deleteExisting(userId, operation);
    });
    const failureService = createPersonalDataService({
      repository: failureRepository,
      storage: storageWith(() => Promise.resolve('deleted')),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const failureSummary = await failureService.getPersonalDataSummary('user-a');
    if (failureSummary.snapshotToken === null) throw new Error('Expected account snapshot');
    const failureCommand: DeleteAccountCommand = {
      snapshotToken: failureSummary.snapshotToken,
      idempotencyKey: 'delete-account-db-failure-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    };

    await expect(failureService.deleteAccount('user-a', failureCommand))
      .rejects.toThrow('database unavailable');
    expect(await rawFailure.readExisting('user-a')).toMatchObject({
      accountDeletion: { idempotencyKey: failureCommand.idempotencyKey }
    });
    await expect(failureService.deleteAccount('user-a', failureCommand)).resolves.toMatchObject({
      kind: 'account_deleted'
    });

    const rawLoss = new InMemoryPlanningRepository();
    await seedAccount(rawLoss);
    let loseResponse = true;
    const lossRepository = wrapRepository(rawLoss, async (userId, operation) => {
      const result = await rawLoss.deleteExisting(userId, operation);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return result;
    });
    const lossService = createPersonalDataService({
      repository: lossRepository,
      storage: storageWith(() => Promise.resolve('deleted')),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const lossSummary = await lossService.getPersonalDataSummary('user-a');
    if (lossSummary.snapshotToken === null) throw new Error('Expected account snapshot');
    const lossCommand: DeleteAccountCommand = {
      snapshotToken: lossSummary.snapshotToken,
      idempotencyKey: 'delete-account-response-loss-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    };

    await expect(lossService.deleteAccount('user-a', lossCommand)).rejects.toThrow('response lost');
    await expect(lossService.deleteAccount('user-a', lossCommand)).resolves.toEqual({
      kind: 'account_already_absent',
      deletedPrivateFileCount: 0
    });
  });

  test('rejects an old delete command after recreation and never touches another user', async () => {
    const repository = new InMemoryPlanningRepository();
    await seedAccount(repository, 'user-a');
    await seedAccount(repository, 'user-b', '2026-08-20T00:00:00.000Z', 'other-user');
    const service = createPersonalDataService({
      repository,
      storage: storageWith(() => Promise.resolve('deleted')),
      now: () => '2026-08-20T02:00:00.000Z'
    });
    const first = await service.getPersonalDataSummary('user-a');
    const otherBefore = await repository.readExisting('user-b');
    if (first.snapshotToken === null) throw new Error('Expected account snapshot');
    const oldCommand: DeleteAccountCommand = {
      snapshotToken: first.snapshotToken,
      idempotencyKey: 'delete-account-recreate-001',
      confirmation: 'DELETE_MY_ACCOUNT'
    };
    await service.deleteAccount('user-a', oldCommand);
    await seedAccount(
      repository,
      'user-a',
      '2026-08-21T00:00:00.000Z',
      'recreated'
    );
    const recreated = await service.getPersonalDataSummary('user-a');

    expect(recreated.snapshotToken).not.toBe(first.snapshotToken);
    await expect(service.deleteAccount('user-a', oldCommand)).rejects.toMatchObject({
      code: 'personal_data_snapshot_conflict'
    });
    expect(await repository.readExisting('user-b')).toEqual(otherBefore);
  });
});
