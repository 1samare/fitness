import type { PlanningAggregateState, PrivatePhotoStorage } from '@fitness/domain';
import { AccountDeletionPendingError } from './account-deletion-guarded-repository';
import {
  PLANNING_AGGREGATE_MAX_UTF8_BYTES,
  assertPlanningAggregateCapacity,
  planningAggregateUtf8Bytes
} from './planning-aggregate-capacity';
import {
  computePersonalDataSnapshotToken,
  projectPersonalDataExport,
  type PersonalDataExportV1
} from './personal-data-export';
import {
  PersonalDataDocumentNotFoundError,
  type PersonalDataRepository
} from './personal-data-repository';
import { requestFingerprint } from './idempotency-fingerprint';
import { StorageUnavailableError } from './ingredient-photo';
import { IdempotencyKeyReuseError } from './versioned-planning';

export interface PersonalDataSummary {
  readonly kind: 'personal_data_summary';
  readonly dataExists: boolean;
  readonly snapshotToken: string | null;
  readonly deletionStatus: 'none' | 'pending';
  readonly capacityStatus: 'within_limit' | 'admin_recovery_required';
  readonly activeVersions: {
    readonly bodyProfile: number;
    readonly goal: number;
    readonly trainingPlan: number;
    readonly inventory: number;
    readonly mealPlan: number;
  };
  readonly counts: {
    readonly bodyProfileVersions: number;
    readonly goalVersions: number;
    readonly trainingPlanVersions: number;
    readonly dailyTargetVersions: number;
    readonly inventoryVersions: number;
    readonly mealPlanVersions: number;
    readonly ingredientPhotoRecords: number;
    readonly assistantMessages: number;
  };
}

export interface DeleteAccountCommand {
  readonly snapshotToken: string;
  readonly idempotencyKey: string;
  readonly confirmation: 'DELETE_MY_ACCOUNT';
}

export type DeleteAccountResult =
  | { readonly kind: 'account_deleted'; readonly deletedPrivateFileCount: number }
  | { readonly kind: 'account_already_absent'; readonly deletedPrivateFileCount: 0 };

export interface PersonalDataService {
  getPersonalDataSummary(userId: string): Promise<PersonalDataSummary>;
  exportPersonalData(userId: string, snapshotToken: string): Promise<PersonalDataExportV1>;
  deleteAccount(userId: string, command: DeleteAccountCommand): Promise<DeleteAccountResult>;
}

export class PersonalDataSnapshotConflictError extends Error {
  public readonly code = 'personal_data_snapshot_conflict' as const;

  public constructor() {
    super('Personal data changed after the requested snapshot');
    this.name = 'PersonalDataSnapshotConflictError';
  }
}

function activeVersion<T extends { readonly id: string; readonly version: number }>(
  records: readonly T[],
  activeId: string | null
): number {
  if (activeId === null) return 0;
  return records.find((record) => record.id === activeId)?.version ?? 0;
}

function emptySummary(): PersonalDataSummary {
  return {
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
  };
}

function summarize(state: PlanningAggregateState): PersonalDataSummary {
  return {
    kind: 'personal_data_summary',
    dataExists: true,
    snapshotToken: computePersonalDataSnapshotToken(state),
    deletionStatus: state.accountDeletion === null ? 'none' : 'pending',
    capacityStatus: planningAggregateUtf8Bytes(state) <= PLANNING_AGGREGATE_MAX_UTF8_BYTES
      ? 'within_limit'
      : 'admin_recovery_required',
    activeVersions: {
      bodyProfile: activeVersion(state.bodyProfiles, state.activeBodyProfileVersionId),
      goal: activeVersion(state.goals, state.activeGoalVersionId),
      trainingPlan: activeVersion(state.trainingPlans, state.activeTrainingPlanVersionId),
      inventory: activeVersion(state.inventories, state.activeInventoryVersionId),
      mealPlan: activeVersion(state.mealPlans, state.activeMealPlanVersionId)
    },
    counts: {
      bodyProfileVersions: state.bodyProfiles.length,
      goalVersions: state.goals.length,
      trainingPlanVersions: state.trainingPlans.length,
      dailyTargetVersions: state.dailyEnergyTargets.length + state.dailyNutritionTargets.length,
      inventoryVersions: state.inventories.length,
      mealPlanVersions: state.mealPlans.length,
      ingredientPhotoRecords: state.ingredientPhotoVersions.length,
      assistantMessages: state.assistantConversation.recentMessages.length
    }
  };
}

function isPersonalDataDocumentNotFound(error: unknown): boolean {
  return error instanceof PersonalDataDocumentNotFoundError
    || (typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'personal_data_document_not_found');
}

function assertMatchingPendingDeletion(
  state: PlanningAggregateState,
  command: DeleteAccountCommand,
  fingerprint: string
): void {
  const pending = state.accountDeletion;
  if (pending === null || pending.idempotencyKey !== command.idempotencyKey) {
    throw new AccountDeletionPendingError();
  }
  if (pending.requestFingerprint !== fingerprint) {
    throw new IdempotencyKeyReuseError(command.idempotencyKey);
  }
  if (
    pending.snapshotToken !== command.snapshotToken
    || computePersonalDataSnapshotToken(state) !== pending.snapshotToken
  ) {
    throw new PersonalDataSnapshotConflictError();
  }
}

export function createPersonalDataService(input: {
  readonly repository: PersonalDataRepository;
  readonly storage: PrivatePhotoStorage;
  readonly now: () => string;
}): PersonalDataService {
  return {
    async getPersonalDataSummary(userId) {
      const state = await input.repository.readExisting(userId);
      return state === null ? emptySummary() : summarize(state);
    },

    async exportPersonalData(userId, snapshotToken) {
      const state = await input.repository.readExisting(userId);
      if (state === null) throw new PersonalDataSnapshotConflictError();
      if (state.accountDeletion !== null) throw new AccountDeletionPendingError();
      assertPlanningAggregateCapacity(state);
      const currentToken = computePersonalDataSnapshotToken(state);
      if (currentToken !== snapshotToken) throw new PersonalDataSnapshotConflictError();
      return projectPersonalDataExport(state, currentToken, input.now());
    },

    async deleteAccount(userId, command) {
      if (command.confirmation !== 'DELETE_MY_ACCOUNT') {
        throw new TypeError('Exact account deletion confirmation is required');
      }
      if (await input.repository.readExisting(userId) === null) {
        return { kind: 'account_already_absent', deletedPrivateFileCount: 0 };
      }
      const fingerprint = requestFingerprint(command);
      const deletion = await input.repository.transact(userId, (current) => {
        const token = computePersonalDataSnapshotToken(current);
        const pending = current.accountDeletion;
        if (pending !== null) {
          if (pending.idempotencyKey !== command.idempotencyKey) {
            throw new AccountDeletionPendingError();
          }
          if (pending.requestFingerprint !== fingerprint) {
            throw new IdempotencyKeyReuseError(command.idempotencyKey);
          }
          assertMatchingPendingDeletion(current, command, fingerprint);
          return {
            nextState: current,
            result: { fingerprint, privateFileIds: pending.privateFileIds }
          };
        }
        if (current.idempotencyRecords.some((record) => record.key === command.idempotencyKey)) {
          throw new IdempotencyKeyReuseError(command.idempotencyKey);
        }
        if (token !== command.snapshotToken) throw new PersonalDataSnapshotConflictError();
        const privateFileIds = [...new Set(
          current.ingredientPhotoVersions.map((photo) => photo.expectedPrivateFileId)
        )].sort();
        return {
          nextState: {
            ...current,
            accountDeletion: {
              status: 'pending',
              idempotencyKey: command.idempotencyKey,
              requestFingerprint: fingerprint,
              snapshotToken: token,
              requestedAt: input.now(),
              privateFileIds
            }
          },
          result: { fingerprint, privateFileIds }
        };
      });

      let deletedPrivateFileCount = 0;
      for (const privateFileId of deletion.privateFileIds) {
        const outcome: unknown = await input.storage.deletePrivateFile({ privateFileId });
        if (outcome === 'deleted') {
          deletedPrivateFileCount += 1;
        } else if (outcome !== 'not_found') {
          throw new StorageUnavailableError();
        }
      }

      try {
        await input.repository.deleteExisting(userId, (current) => {
          assertMatchingPendingDeletion(current, command, deletion.fingerprint);
          return undefined;
        });
      } catch (error: unknown) {
        if (isPersonalDataDocumentNotFound(error)) {
          return { kind: 'account_already_absent', deletedPrivateFileCount: 0 };
        }
        throw error;
      }
      return { kind: 'account_deleted', deletedPrivateFileCount };
    }
  };
}
