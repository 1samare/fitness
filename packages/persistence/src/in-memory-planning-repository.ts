import type { PlanningRepository } from '@fitness/application';
import {
  emptyAssistantConversationState,
  type PlanningAggregateState
} from '@fitness/domain';
import { parseAndAssertPlanningState } from './planning-aggregate-invariants';

const emptyState: PlanningAggregateState = {
  assistantConversation: emptyAssistantConversationState(),
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

export class InMemoryPlanningRepository implements PlanningRepository {
  private readonly states = new Map<string, PlanningAggregateState>();
  private readonly queues = new Map<string, Promise<void>>();

  public read(userId: string): Promise<PlanningAggregateState> {
    return Promise.resolve(copyState(this.states.get(userId) ?? emptyState));
  }

  public async transact<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => {
      readonly nextState: PlanningAggregateState;
      readonly result: TResult;
    }
  ): Promise<TResult> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(userId, previous.then(() => gate));
    await previous;
    try {
      const current = copyState(this.states.get(userId) ?? emptyState);
      const { nextState, result } = operation(current);
      const validated = parseAndAssertPlanningState(nextState, userId);
      this.states.set(userId, copyState(validated));
      return result;
    } finally {
      release?.();
    }
  }
}
