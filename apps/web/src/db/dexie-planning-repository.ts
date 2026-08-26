import {
  assertPlanningAggregateCapacityTransition,
  PersonalDataDocumentNotFoundError,
  type PersonalDataRepository
} from '@fitness/application/browser';
import {
  InMemoryPlanningRepository,
  parseAndAssertPlanningState
} from '@fitness/persistence/browser';
import { type FitnessLocalDatabase, LOCAL_DATABASE_SCHEMA_VERSION, LOCAL_USER_ID } from './database';
import { LocalRevisionConflictError, LocalUserMismatchError } from './errors';

type PlanningAggregateState = Awaited<ReturnType<PersonalDataRepository['read']>>;

const REVISION_CHANNEL_NAME = 'fitness_local_v1_revision';

interface RevisionMessage {
  readonly type: 'planning_revision';
  readonly userId: typeof LOCAL_USER_ID;
  readonly revision: number;
}

function isRevisionMessage(value: unknown): value is RevisionMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RevisionMessage>;
  return candidate.type === 'planning_revision'
    && candidate.userId === LOCAL_USER_ID
    && typeof candidate.revision === 'number'
    && Number.isInteger(candidate.revision)
    && candidate.revision >= 0;
}

function cloneState(state: PlanningAggregateState): PlanningAggregateState {
  return structuredClone(state);
}

export class DexiePlanningRepository implements PersonalDataRepository {
  private readonly emptyRepository = new InMemoryPlanningRepository();
  private readonly revisionChannel: BroadcastChannel | null;
  private observedRevision: number | undefined;
  private remoteRevision = 0;

  public constructor(private readonly database: FitnessLocalDatabase) {
    this.revisionChannel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(REVISION_CHANNEL_NAME)
      : null;
    this.revisionChannel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isRevisionMessage(event.data)) {
        this.remoteRevision = Math.max(this.remoteRevision, event.data.revision);
      }
    });
  }

  public get hasRemoteChanges(): boolean {
    return this.observedRevision !== undefined && this.remoteRevision > this.observedRevision;
  }

  public async read(userId: string): Promise<PlanningAggregateState> {
    this.assertLocalUser(userId);
    const row = await this.database.planningStates.get(LOCAL_USER_ID);
    if (!row) {
      this.observedRevision = 0;
      return cloneState(await this.createEmptyState());
    }
    const state = parseAndAssertPlanningState(row.state, LOCAL_USER_ID);
    this.observedRevision = row.revision;
    return cloneState(state);
  }

  public async readExisting(userId: string): Promise<PlanningAggregateState | null> {
    this.assertLocalUser(userId);
    const row = await this.database.planningStates.get(LOCAL_USER_ID);
    if (!row) {
      this.observedRevision = 0;
      return null;
    }
    const state = parseAndAssertPlanningState(row.state, LOCAL_USER_ID);
    this.observedRevision = row.revision;
    return cloneState(state);
  }

  public async transact<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => {
      nextState: PlanningAggregateState;
      result: TResult;
    }
  ): Promise<TResult> {
    this.assertLocalUser(userId);
    const emptyState = await this.createEmptyState();
    const outcome = await this.database.transaction('rw', this.database.planningStates, async () => {
      const row = await this.database.planningStates.get(LOCAL_USER_ID);
      const currentRevision = row?.revision ?? 0;
      const expectedRevision = this.observedRevision ?? currentRevision;
      if (expectedRevision !== currentRevision) {
        throw new LocalRevisionConflictError(expectedRevision, currentRevision);
      }
      const currentState = row
        ? parseAndAssertPlanningState(row.state, LOCAL_USER_ID)
        : emptyState;
      const operationResult = operation(cloneState(currentState));
      const nextState = parseAndAssertPlanningState(operationResult.nextState, LOCAL_USER_ID);
      assertPlanningAggregateCapacityTransition(currentState, nextState);
      const nextRevision = currentRevision + 1;
      await this.database.planningStates.put({
        userId: LOCAL_USER_ID,
        schemaVersion: LOCAL_DATABASE_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
        state: cloneState(nextState)
      });
      return { result: operationResult.result, revision: nextRevision };
    });
    this.observedRevision = outcome.revision;
    this.remoteRevision = Math.max(this.remoteRevision, outcome.revision);
    this.revisionChannel?.postMessage({
      type: 'planning_revision',
      userId: LOCAL_USER_ID,
      revision: outcome.revision
    } satisfies RevisionMessage);
    return outcome.result;
  }

  public async deleteExisting<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => TResult
  ): Promise<TResult> {
    this.assertLocalUser(userId);
    const result = await this.database.transaction('rw', this.database.planningStates, async () => {
      const row = await this.database.planningStates.get(LOCAL_USER_ID);
      if (!row) throw new PersonalDataDocumentNotFoundError();
      const expectedRevision = this.observedRevision ?? row.revision;
      if (expectedRevision !== row.revision) {
        throw new LocalRevisionConflictError(expectedRevision, row.revision);
      }
      const current = parseAndAssertPlanningState(row.state, LOCAL_USER_ID);
      const operationResult = operation(cloneState(current));
      await this.database.planningStates.delete(LOCAL_USER_ID);
      return operationResult;
    });
    this.observedRevision = 0;
    this.remoteRevision = 0;
    return result;
  }

  public close(): void {
    this.revisionChannel?.close();
    this.database.close();
  }

  private assertLocalUser(userId: string): asserts userId is typeof LOCAL_USER_ID {
    if (userId !== LOCAL_USER_ID) throw new LocalUserMismatchError(userId);
  }

  private async createEmptyState(): Promise<PlanningAggregateState> {
    return this.emptyRepository.read(LOCAL_USER_ID);
  }
}
