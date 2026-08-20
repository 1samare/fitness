import { describe, expect, test, vi } from 'vitest';
import type { PlanningAggregateState } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { createAccountDeletionGuardedRepository } from './account-deletion-guarded-repository';

const pendingDeletion = {
  status: 'pending' as const,
  idempotencyKey: 'delete-account-0001',
  requestFingerprint: `v2:sha256:${'a'.repeat(64)}`,
  snapshotToken: 'snapshot-token-0001',
  requestedAt: '2026-08-20T00:00:00.000Z',
  privateFileIds: []
};

describe('account deletion guarded repository', () => {
  test('blocks both reads and transactions while deletion is pending', async () => {
    const raw = new InMemoryPlanningRepository();
    await raw.transact('user-a', (state) => ({
      nextState: { ...state, accountDeletion: pendingDeletion },
      result: undefined
    }));
    const guarded = createAccountDeletionGuardedRepository(raw);
    const operation = vi.fn((state: PlanningAggregateState) => ({
      nextState: state,
      result: undefined
    }));

    await expect(guarded.read('user-a')).rejects.toMatchObject({
      code: 'account_deletion_pending'
    });
    await expect(guarded.transact('user-a', operation)).rejects.toMatchObject({
      code: 'account_deletion_pending'
    });
    expect(operation).not.toHaveBeenCalled();
  });

  test('passes through reads and transactions when no deletion is pending', async () => {
    const raw = new InMemoryPlanningRepository();
    const guarded = createAccountDeletionGuardedRepository(raw);

    await expect(guarded.read('user-a')).resolves.toMatchObject({ accountDeletion: null });
    await expect(guarded.transact('user-a', (state) => ({
      nextState: state,
      result: 'ok'
    }))).resolves.toBe('ok');
  });
});
