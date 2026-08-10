import { createHash } from 'node:crypto';
import type { PlanningRepository } from '@fitness/application';
import { planningAggregateStateSchema } from '@fitness/contracts';
import type { PlanningAggregateState } from '@fitness/domain';
import {
  CorruptPlanningStateError,
  assertPlanningAggregateInvariants
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
    outboxEvents: [],
    idempotencyRecords: [],
    activeBodyProfileVersionId: null,
    activeGoalVersionId: null,
    activeTrainingPlanVersionId: null
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
  readonly schemaVersion: 3;
  readonly state: PlanningAggregateState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeDocument(value: unknown, userId: string): PlanningAggregateState {
  if (
    !isRecord(value)
    || (value.schemaVersion !== 2 && value.schemaVersion !== 3)
    || !isRecord(value.state)
  ) {
    throw new CorruptPlanningStateError();
  }
  const candidateState = value.schemaVersion === 2
    ? { ...value.state, dailyNutritionTargets: [] }
    : value.state;
  const parsed = planningAggregateStateSchema.safeParse(candidateState);
  if (!parsed.success) throw new CorruptPlanningStateError();
  assertPlanningAggregateInvariants(parsed.data, userId);
  return parsed.data;
}

function encodeDocument(
  state: PlanningAggregateState,
  userId: string
): StoredPlanningDocument {
  const parsed = planningAggregateStateSchema.safeParse(state);
  if (!parsed.success) throw new CorruptPlanningStateError();
  assertPlanningAggregateInvariants(parsed.data, userId);
  return { schemaVersion: 3, state: parsed.data };
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
        ? createEmptyState()
        : decodeDocument(stored.data, userId);
      const { nextState, result } = operation(current);
      await reference.set({ data: encodeDocument(nextState, userId) });
      return result;
    });
  }
}
