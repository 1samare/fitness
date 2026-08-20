import { describe, expect, test } from 'vitest';
import {
  createAccountDeletionGuardedRepository,
  createPersonalDataService,
  createVersionedPlanningService
} from '../../packages/application/src/index';
import { InMemoryPlanningRepository } from '../../packages/persistence/src/index';
import { createPlanningApiHandler } from '../../cloudfunctions/planning-api/src/handler';

describe('personal data API workflow', () => {
  test('keeps two trusted identities isolated through summary, export, and deletion', async () => {
    const rawRepository = new InMemoryPlanningRepository();
    const repository = createAccountDeletionGuardedRepository(rawRepository);
    let sequence = 0;
    const now = () => '2026-08-20T00:00:00.000Z';
    const planning = createVersionedPlanningService({
      repository,
      now,
      nextId: (prefix) => `${prefix}-${String(++sequence)}`
    });
    const personalData = createPersonalDataService({
      repository: rawRepository,
      storage: {
        inspectPrivateFile: () => Promise.reject(new Error('unused')),
        deletePrivateFile: () => Promise.resolve('not_found')
      },
      now
    });
    const handler = createPlanningApiHandler(Object.assign(planning, personalData));
    const profile = (suffix: string) => ({
      action: 'saveBodyProfile',
      payload: {
        expectedVersion: 0,
        idempotencyKey: `profile-personal-e2e-${suffix}`,
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
    } as const);
    await handler(profile('a'), { userId: 'user-a' });
    await handler(profile('b'), { userId: 'user-b' });
    const summaryA = await handler({ action: 'getPersonalDataSummary' }, { userId: 'user-a' });
    const summaryB = await handler({ action: 'getPersonalDataSummary' }, { userId: 'user-b' });
    if (
      !summaryA.success
      || summaryA.data.kind !== 'personal_data_summary'
      || summaryA.data.snapshotToken === null
      || !summaryB.success
      || summaryB.data.kind !== 'personal_data_summary'
      || summaryB.data.snapshotToken === null
    ) throw new Error('Expected isolated personal-data summaries');

    await expect(handler({
      action: 'exportPersonalData',
      snapshotToken: summaryA.data.snapshotToken
    }, { userId: 'user-b' })).resolves.toMatchObject({
      success: false,
      error: { code: 'personal_data_snapshot_conflict' }
    });
    await expect(handler({
      action: 'deleteAccount',
      payload: {
        snapshotToken: summaryA.data.snapshotToken,
        idempotencyKey: 'delete-account-personal-e2e-001',
        confirmation: 'DELETE_MY_ACCOUNT'
      }
    }, { userId: 'user-a' })).resolves.toMatchObject({
      success: true,
      data: { kind: 'account_deleted' }
    });

    await expect(handler({ action: 'getPersonalDataSummary' }, { userId: 'user-a' }))
      .resolves.toMatchObject({ success: true, data: { dataExists: false } });
    await expect(handler({ action: 'getPersonalDataSummary' }, { userId: 'user-b' }))
      .resolves.toMatchObject({
        success: true,
        data: { dataExists: true, snapshotToken: summaryB.data.snapshotToken }
      });
  });
});
