import {
  PersonalDataDocumentNotFoundError,
  assertPlanningAggregateCapacity,
  type PersonalDataRepository
} from '@fitness/application';
import {
  emptyAssistantConversationState,
  type PlanningAggregateState
} from '@fitness/domain';
import { parseAndAssertPlanningState } from './planning-aggregate-invariants';

const emptyState: PlanningAggregateState = {
  assistantConversation: emptyAssistantConversationState(),
  accountDeletion: null,
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

function copyState(state: PlanningAggregateState): PlanningAggregateState {
  return structuredClone(state);
}

export class InMemoryPlanningRepository implements PersonalDataRepository {
  private readonly states = new Map<string, PlanningAggregateState>();
  private readonly queues = new Map<string, Promise<void>>();

  public read(userId: string): Promise<PlanningAggregateState> {
    return Promise.resolve(copyState(this.states.get(userId) ?? emptyState));
  }

  public async readExisting(userId: string): Promise<PlanningAggregateState | null> {
    await (this.queues.get(userId) ?? Promise.resolve());
    const state = this.states.get(userId);
    return state === undefined ? null : copyState(state);
  }

  public async transact<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => {
      readonly nextState: PlanningAggregateState;
      readonly result: TResult;
    }
  ): Promise<TResult> {
    return this.serialize(userId, () => {
      const current = copyState(this.states.get(userId) ?? emptyState);
      const { nextState, result } = operation(current);
      assertPlanningAggregateCapacity(nextState);
      const validated = parseAndAssertPlanningState(nextState, userId);
      this.states.set(userId, copyState(validated));
      return result;
    });
  }

  public deleteExisting<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => TResult
  ): Promise<TResult> {
    return this.serialize(userId, () => {
      const stored = this.states.get(userId);
      if (stored === undefined) throw new PersonalDataDocumentNotFoundError();
      const result = operation(copyState(stored));
      this.states.delete(userId);
      return result;
    });
  }

  private async serialize<TResult>(
    userId: string,
    operation: () => TResult
  ): Promise<TResult> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.queues.set(userId, queued);
    await previous;
    try {
      return operation();
    } finally {
      release();
      if (this.queues.get(userId) === queued) this.queues.delete(userId);
    }
  }
}
