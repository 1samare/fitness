import { createHash } from 'node:crypto';
import type { PlanningRepository } from '@fitness/application';
import type { PlanningAggregateState } from '@fitness/domain';
import {
  CorruptPlanningStateError,
  parseAndAssertPlanningState
} from './planning-aggregate-invariants';

export { CorruptPlanningStateError } from './planning-aggregate-invariants';

const collectionName = 'planning_user_states';

function createEmptyState(): PlanningAggregateState {
  return {
    bodyProfiles: [],
    goals: [],
    trainingPlans: [],
    dailyEnergyTargets: [],
    dailyNutritionTargets: [],
    inventories: [],
    mealPlans: [],
    mealPlanTargetDiffs: [],
    mealPlanDecisions: [],
    trainingCompletionEvents: [],
    recalculationJobs: [],
    ingredientPhotoVersions: [],
    outboxEvents: [],
    idempotencyRecords: [],
    activeBodyProfileVersionId: null,
    activeGoalVersionId: null,
    activeTrainingPlanVersionId: null,
    activeInventoryVersionId: null,
    activeMealPlanVersionId: null,
    nextPhotoCleanupAt: null
  };
}

export interface CloudBaseDocumentReference {
  get(): Promise<{ readonly data?: unknown }>;
  set(input: { readonly data: unknown }): Promise<unknown>;
}

interface CloudBaseCollection {
  doc(id: string): CloudBaseDocumentReference;
}

export interface CloudBaseTransaction {
  collection(name: string): CloudBaseCollection;
}

export interface CloudBaseDatabase extends CloudBaseTransaction {
  runTransaction<TResult>(
    operation: (transaction: CloudBaseTransaction) => Promise<TResult>
  ): Promise<TResult>;
}

interface StoredPlanningDocument {
  readonly schemaVersion: 6;
  readonly state: PlanningAggregateState & { readonly userId: string };
}

const phase4Empty = {
  inventories: [],
  mealPlans: [],
  mealPlanTargetDiffs: [],
  mealPlanDecisions: [],
  trainingCompletionEvents: [],
  recalculationJobs: [],
  activeInventoryVersionId: null,
  activeMealPlanVersionId: null
} as const;

const phase5Empty = {
  ingredientPhotoVersions: [],
  nextPhotoCleanupAt: null
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrateV4RecalculationConflictDetails(
  state: Record<string, unknown>
): Record<string, unknown> {
  if (!Array.isArray(state.recalculationJobs)) return state;
  const recalculationJobs: readonly unknown[] = state.recalculationJobs;
  return {
    ...state,
    recalculationJobs: recalculationJobs.map((job): unknown => {
      if (
        !isRecord(job)
        || Object.hasOwn(job, 'failureConflictDetailsStatus')
        || Object.hasOwn(job, 'failureConflicts')
      ) return job;
      return {
        ...job,
        failureConflictDetailsStatus: 'legacy_unavailable',
        failureConflicts: []
      };
    })
  };
}

export function decodePlanningDocument(value: unknown, userId: string): PlanningAggregateState {
  if (
    !isRecord(value)
    || (value.schemaVersion !== 2
      && value.schemaVersion !== 3
      && value.schemaVersion !== 4
      && value.schemaVersion !== 5
      && value.schemaVersion !== 6)
    || !isRecord(value.state)
  ) {
    throw new CorruptPlanningStateError();
  }
  const persistedUserId = value.state.userId;
  if (persistedUserId !== undefined && persistedUserId !== userId) {
    throw new CorruptPlanningStateError();
  }
  const storedState = { ...value.state };
  delete storedState.userId;
  const candidateState = value.schemaVersion === 2
    ? { ...storedState, dailyNutritionTargets: [], ...phase4Empty, ...phase5Empty }
    : value.schemaVersion === 3
      ? { ...storedState, ...phase4Empty, ...phase5Empty }
      : value.schemaVersion === 4
        ? { ...migrateV4RecalculationConflictDetails(storedState), ...phase5Empty }
        : value.schemaVersion === 5
          ? { ...storedState, ...phase5Empty }
          : storedState;
  return parseAndAssertPlanningState(candidateState, userId);
}

export function decodePlanningDocumentForCleanup(value: unknown): {
  readonly userId: string;
  readonly state: PlanningAggregateState;
} {
  if (
    !isRecord(value)
    || value.schemaVersion !== 6
    || !isRecord(value.state)
    || typeof value.state.userId !== 'string'
    || value.state.userId.length === 0
  ) throw new CorruptPlanningStateError();
  const userId = value.state.userId;
  return { userId, state: decodePlanningDocument(value, userId) };
}

function encodeDocument(
  state: PlanningAggregateState,
  userId: string
): StoredPlanningDocument {
  return {
    schemaVersion: 6,
    state: { ...parseAndAssertPlanningState(state, userId), userId }
  };
}

export class CloudBasePlanningRepository implements PlanningRepository {
  public constructor(private readonly database: CloudBaseDatabase) {}

  public documentIdForUser(userId: string): string {
    return createHash('sha256').update(userId, 'utf8').digest('hex');
  }

  public async read(userId: string): Promise<PlanningAggregateState> {
    const result = await this.database
      .collection(collectionName)
      .doc(this.documentIdForUser(userId))
      .get();
    return result.data === undefined
      ? createEmptyState()
      : decodePlanningDocument(result.data, userId);
  }

  public async transact<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => {
      readonly nextState: PlanningAggregateState;
      readonly result: TResult;
    }
  ): Promise<TResult> {
    const documentId = this.documentIdForUser(userId);
    return this.database.runTransaction(async (transaction) => {
      const reference = transaction.collection(collectionName).doc(documentId);
      const stored = await reference.get();
      const current = stored.data === undefined
        ? createEmptyState()
        : decodePlanningDocument(stored.data, userId);
      const { nextState, result } = operation(current);
      await reference.set({ data: encodeDocument(nextState, userId) });
      return result;
    });
  }
}
