import type { PlanningRepository } from './versioned-planning';

export class AccountDeletionPendingError extends Error {
  public readonly code = 'account_deletion_pending' as const;

  public constructor() {
    super('Account deletion is pending');
    this.name = 'AccountDeletionPendingError';
  }
}

export function createAccountDeletionGuardedRepository(
  repository: PlanningRepository
): PlanningRepository {
  return {
    async read(userId) {
      const state = await repository.read(userId);
      if (state.accountDeletion !== null) throw new AccountDeletionPendingError();
      return state;
    },
    transact: (userId, operation) => repository.transact(userId, (current) => {
      if (current.accountDeletion !== null) throw new AccountDeletionPendingError();
      return operation(current);
    })
  };
}
