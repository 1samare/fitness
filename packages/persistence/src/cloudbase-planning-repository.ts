import { createHash } from 'node:crypto';
import type { PlanningRepository } from '@fitness/application';
import { planningAggregateStateSchema } from '@fitness/contracts';
import type { PlanningAggregateState } from '@fitness/domain';

const collectionName = 'planning_user_states';

const emptyState: PlanningAggregateState = {
  bodyProfiles: [],
  goals: [],
  trainingPlans: [],
  dailyEnergyTargets: [],
  idempotencyRecords: [],
  activeBodyProfileVersionId: null,
  activeGoalVersionId: null,
  activeTrainingPlanVersionId: null
};

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
  readonly schemaVersion: 1;
  readonly state: PlanningAggregateState;
}

export class CorruptPlanningStateError extends Error {
  public readonly code = 'corrupt_planning_state' as const;

  public constructor() {
    super('Stored planning state failed runtime validation');
    this.name = 'CorruptPlanningStateError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOwnedByUser(state: PlanningAggregateState, userId: string): boolean {
  return [
    ...state.bodyProfiles,
    ...state.goals,
    ...state.trainingPlans,
    ...state.dailyEnergyTargets
  ].every((version) => version.userId === userId);
}

function decodeDocument(value: unknown, userId: string): PlanningAggregateState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !('state' in value)) {
    throw new CorruptPlanningStateError();
  }
  const parsed = planningAggregateStateSchema.safeParse(value.state);
  if (!parsed.success || !isOwnedByUser(parsed.data, userId)) {
    throw new CorruptPlanningStateError();
  }
  return parsed.data;
}

function encodeDocument(
  state: PlanningAggregateState,
  userId: string
): StoredPlanningDocument {
  const parsed = planningAggregateStateSchema.safeParse(state);
  if (!parsed.success || !isOwnedByUser(parsed.data, userId)) {
    throw new CorruptPlanningStateError();
  }
  return { schemaVersion: 1, state: parsed.data };
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
      ? structuredClone(emptyState)
      : decodeDocument(result.data, userId);
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
        ? structuredClone(emptyState)
        : decodeDocument(stored.data, userId);
      const { nextState, result } = operation(current);
      await reference.set({ data: encodeDocument(nextState, userId) });
      return result;
    });
  }
}
