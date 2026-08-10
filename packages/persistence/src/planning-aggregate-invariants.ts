import { addBusinessDays, planningAggregateStateSchema } from '@fitness/contracts';
import type {
  IdempotencyRecord,
  InventoryVersion,
  MealPlanVersion,
  PlanningAggregateState,
  TrainingPlanChangedEvent
} from '@fitness/domain';

export class CorruptPlanningStateError extends Error {
  public readonly code = 'corrupt_planning_state' as const;

  public constructor() {
    super('Stored planning state failed runtime validation');
    this.name = 'CorruptPlanningStateError';
  }
}

function corrupt(): never {
  throw new CorruptPlanningStateError();
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) corrupt();
}

function assertContiguous(versions: readonly number[]): void {
  const seen = new Set<number>();
  let maximum = 0;
  for (const version of versions) {
    if (!Number.isInteger(version) || version < 1 || seen.has(version)) corrupt();
    seen.add(version);
    maximum = Math.max(maximum, version);
  }
  if (maximum !== versions.length) corrupt();
}

function assertContiguousByBusinessDate(
  values: readonly { readonly businessDate: string; readonly version: number }[]
): void {
  const versionsByDate = new Map<string, number[]>();
  for (const value of values) {
    const versions = versionsByDate.get(value.businessDate) ?? [];
    versions.push(value.version);
    versionsByDate.set(value.businessDate, versions);
  }
  for (const versions of versionsByDate.values()) assertContiguous(versions);
}

function assertSortedUniqueDates(dates: readonly string[]): void {
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (previous === undefined || current === undefined || current <= previous) corrupt();
  }
}

function assertEventDates(event: TrainingPlanChangedEvent): void {
  assertSortedUniqueDates(event.affectedDates);
}

interface EntityIds {
  readonly bodyProfiles: ReadonlySet<string>;
  readonly goals: ReadonlySet<string>;
  readonly trainingPlans: ReadonlySet<string>;
  readonly dailyTargets: ReadonlySet<string>;
  readonly inventories: ReadonlySet<string>;
  readonly mealPlans: ReadonlySet<string>;
  readonly mealPlanDecisions: ReadonlySet<string>;
  readonly trainingCompletions: ReadonlySet<string>;
  readonly recalculationJobs: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
}

interface IdempotencyReferences {
  readonly goals: ReadonlyMap<string, PlanningAggregateState['goals'][number]>;
  readonly trainingPlans: ReadonlyMap<
    string,
    PlanningAggregateState['trainingPlans'][number]
  >;
  readonly dailyTargets: ReadonlyMap<
    string,
    PlanningAggregateState['dailyEnergyTargets'][number]
  >;
  readonly events: ReadonlyMap<string, TrainingPlanChangedEvent>;
}

function assertIdempotencyResult(
  record: IdempotencyRecord,
  entityIds: EntityIds,
  references: IdempotencyReferences
): void {
  if (record.operation === 'saveBodyProfile') {
    if (!entityIds.bodyProfiles.has(record.resultVersionId)) corrupt();
    return;
  }
  if (record.operation === 'saveGoal') {
    if (!entityIds.goals.has(record.resultVersionId)) corrupt();
    return;
  }
  if (record.operation === 'saveTrainingPlan') {
    if (!entityIds.trainingPlans.has(record.resultVersionId)) corrupt();
    return;
  }
  if (record.operation === 'saveInventory') {
    if (!entityIds.inventories.has(record.resultVersionId)) corrupt();
    return;
  }
  if (
    record.operation === 'generateWeeklyMealPlan'
    || record.operation === 'setMealPlanDayLock'
    || record.operation === 'updateMealPlanDay'
  ) {
    if (!entityIds.mealPlans.has(record.resultVersionId)) corrupt();
    return;
  }
  if (record.operation === 'recordTrainingCompletion') {
    if (!entityIds.trainingCompletions.has(record.resultVersionId)) corrupt();
    return;
  }
  if (record.operation === 'decideMealPlanCandidate') {
    if (!entityIds.mealPlanDecisions.has(record.resultVersionId)) corrupt();
    return;
  }
  if (record.operation === 'retryPendingRecalculation') {
    if (!entityIds.recalculationJobs.has(record.resultVersionId)) corrupt();
    return;
  }

  const result = record.resultVersionIds;
  assertUnique(result.dailyEnergyTargetVersionIds);
  if (
    !entityIds.bodyProfiles.has(result.bodyProfileVersionId)
    || !entityIds.goals.has(result.goalVersionId)
    || !entityIds.trainingPlans.has(result.trainingPlanVersionId)
    || !entityIds.events.has(result.eventId)
    || result.dailyEnergyTargetVersionIds.some((id) => !entityIds.dailyTargets.has(id))
  ) {
    corrupt();
  }
  const goal = references.goals.get(result.goalVersionId);
  const plan = references.trainingPlans.get(result.trainingPlanVersionId);
  const event = references.events.get(result.eventId);
  if (
    goal?.bodyProfileVersionId !== result.bodyProfileVersionId
    || plan?.bodyProfileVersionId !== result.bodyProfileVersionId
    || plan.goalVersionId !== result.goalVersionId
    || event?.trainingPlanVersionId !== result.trainingPlanVersionId
    || event.bodyProfileVersionId !== result.bodyProfileVersionId
    || event.goalVersionId !== result.goalVersionId
  ) {
    corrupt();
  }
  for (const targetId of result.dailyEnergyTargetVersionIds) {
    const target = references.dailyTargets.get(targetId);
    if (
      target === undefined
      || target.bodyProfileVersionId !== result.bodyProfileVersionId
      || target.goalVersionId !== result.goalVersionId
      || target.trainingPlanVersionId !== result.trainingPlanVersionId
    ) {
      corrupt();
    }
  }
}

function inventoryItemsByFood(inventory: InventoryVersion): Map<string, InventoryVersion['items'][number]> {
  const byFood = new Map<string, InventoryVersion['items'][number]>();
  const snapshotIds = new Set<string>();
  for (const item of inventory.items) {
    if (
      byFood.has(item.foodId)
      || snapshotIds.has(item.nutritionSnapshotId)
      || !Number.isFinite(item.availableGrams)
      || item.availableGrams <= 0
    ) {
      corrupt();
    }
    byFood.set(item.foodId, item);
    snapshotIds.add(item.nutritionSnapshotId);
  }
  return byFood;
}

interface TrainingPlanLineage {
  readonly enteredAt: ReadonlyMap<string, number>;
  readonly exitedAt: ReadonlyMap<string, number>;
}

function buildTrainingPlanLineage(
  trainingPlans: ReadonlyMap<string, PlanningAggregateState['trainingPlans'][number]>,
  events: readonly TrainingPlanChangedEvent[]
): TrainingPlanLineage {
  const predecessors = new Map<string, string | null>();
  const successors = new Map<string, string[]>();
  for (const event of events) {
    if (predecessors.has(event.trainingPlanVersionId)) corrupt();
    const plan = trainingPlans.get(event.trainingPlanVersionId);
    if (plan === undefined) corrupt();
    const previousId = event.previousTrainingPlanVersionId;
    if (previousId !== null) {
      const previous = trainingPlans.get(previousId);
      if (previous === undefined || previous.version >= plan.version) corrupt();
      const children = successors.get(previousId) ?? [];
      children.push(plan.id);
      successors.set(previousId, children);
    }
    predecessors.set(plan.id, previousId);
  }

  const enteredAt = new Map<string, number>();
  const exitedAt = new Map<string, number>();
  let clock = 0;
  const roots = [...trainingPlans.keys()].filter((id) => {
    const previousId = predecessors.get(id);
    return previousId === undefined || previousId === null;
  });
  for (const rootId of roots) {
    const stack: { readonly id: string; readonly exiting: boolean }[] = [
      { id: rootId, exiting: false }
    ];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) corrupt();
      if (frame.exiting) {
        exitedAt.set(frame.id, clock);
        clock += 1;
        continue;
      }
      if (enteredAt.has(frame.id)) corrupt();
      enteredAt.set(frame.id, clock);
      clock += 1;
      stack.push({ id: frame.id, exiting: true });
      const children = successors.get(frame.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childId = children[index];
        if (childId === undefined) corrupt();
        stack.push({ id: childId, exiting: false });
      }
    }
  }
  if (enteredAt.size !== trainingPlans.size || exitedAt.size !== trainingPlans.size) corrupt();
  return { enteredAt, exitedAt };
}

function isTrainingPlanAncestor(
  lineage: TrainingPlanLineage,
  ancestorId: string,
  descendantId: string
): boolean {
  const ancestorEnteredAt = lineage.enteredAt.get(ancestorId);
  const ancestorExitedAt = lineage.exitedAt.get(ancestorId);
  const descendantEnteredAt = lineage.enteredAt.get(descendantId);
  const descendantExitedAt = lineage.exitedAt.get(descendantId);
  return ancestorEnteredAt !== undefined
    && ancestorExitedAt !== undefined
    && descendantEnteredAt !== undefined
    && descendantExitedAt !== undefined
    && ancestorEnteredAt <= descendantEnteredAt
    && ancestorExitedAt >= descendantExitedAt;
}

function assertMealPlan(
  plan: MealPlanVersion,
  references: {
    readonly bodyProfiles: ReadonlyMap<string, PlanningAggregateState['bodyProfiles'][number]>;
    readonly goals: ReadonlyMap<string, PlanningAggregateState['goals'][number]>;
    readonly trainingPlans: ReadonlyMap<string, PlanningAggregateState['trainingPlans'][number]>;
    readonly nutritionTargets: ReadonlyMap<
      string,
      PlanningAggregateState['dailyNutritionTargets'][number]
    >;
    readonly inventories: ReadonlyMap<string, InventoryVersion>;
    readonly mealPlans: ReadonlyMap<string, MealPlanVersion>;
    readonly inventoryItems: ReadonlyMap<string, ReadonlyMap<string, InventoryVersion['items'][number]>>;
    readonly trainingPlanLineage: TrainingPlanLineage;
  }
): void {
  const profile = references.bodyProfiles.get(plan.bodyProfileVersionId);
  const goal = references.goals.get(plan.goalVersionId);
  const trainingPlan = references.trainingPlans.get(plan.trainingPlanVersionId);
  const inventory = references.inventories.get(plan.inventoryVersionId);
  const inventoryItems = references.inventoryItems.get(plan.inventoryVersionId);
  if (
    profile === undefined
    || goal === undefined
    || trainingPlan === undefined
    || inventory === undefined
    || inventoryItems === undefined
    || goal.bodyProfileVersionId !== profile.id
    || trainingPlan.bodyProfileVersionId !== profile.id
    || trainingPlan.goalVersionId !== goal.id
    || trainingPlan.payload.weekStartDate !== plan.weekStartDate
    || plan.days.length !== 7
  ) {
    corrupt();
  }
  if (plan.version === 1) {
    if (plan.supersedesVersionId !== null) corrupt();
  } else {
    const superseded = plan.supersedesVersionId === null
      ? undefined
      : references.mealPlans.get(plan.supersedesVersionId);
    if (superseded === undefined || superseded.version >= plan.version) corrupt();
  }

  const usageByFood = new Map<string, number>();
  for (let index = 0; index < plan.days.length; index += 1) {
    const day = plan.days[index];
    if (day === undefined || day.businessDate !== addBusinessDays(plan.weekStartDate, index)) {
      corrupt();
    }
    const target = references.nutritionTargets.get(day.dailyNutritionTargetVersionId);
    const targetTrainingPlan = target === undefined
      ? undefined
      : references.trainingPlans.get(target.trainingPlanVersionId);
    if (
      target === undefined
      || targetTrainingPlan === undefined
      || target.businessDate !== day.businessDate
      || target.bodyProfileVersionId !== plan.bodyProfileVersionId
      || target.goalVersionId !== plan.goalVersionId
      || targetTrainingPlan.bodyProfileVersionId !== plan.bodyProfileVersionId
      || targetTrainingPlan.goalVersionId !== plan.goalVersionId
      || targetTrainingPlan.payload.weekStartDate !== plan.weekStartDate
      || targetTrainingPlan.version > trainingPlan.version
      || !isTrainingPlanAncestor(
        references.trainingPlanLineage,
        targetTrainingPlan.id,
        trainingPlan.id
      )
    ) {
      corrupt();
    }
    assertUnique(day.meals.map((meal) => meal.slot));
    assertUnique(day.ingredientAmounts.map((amount) => amount.foodId));
    assertUnique(day.nutritionSourceSnapshotIds);
    const expectedSnapshotIds = new Set<string>();
    for (const amount of day.ingredientAmounts) {
      const item = inventoryItems.get(amount.foodId);
      if (item === undefined || !Number.isFinite(amount.grams) || amount.grams <= 0) corrupt();
      expectedSnapshotIds.add(item.nutritionSnapshotId);
      usageByFood.set(amount.foodId, (usageByFood.get(amount.foodId) ?? 0) + amount.grams);
    }
    if (
      expectedSnapshotIds.size !== day.nutritionSourceSnapshotIds.length
      || day.nutritionSourceSnapshotIds.some((id) => !expectedSnapshotIds.has(id))
    ) {
      corrupt();
    }
  }
  for (const [foodId, usedGrams] of usageByFood) {
    const item = inventoryItems.get(foodId);
    if (item === undefined || usedGrams > item.availableGrams) corrupt();
  }
}

function isDirectMealPlanSuccessor(
  successor: MealPlanVersion,
  predecessor: MealPlanVersion
): boolean {
  return successor.supersedesVersionId === predecessor.id
    && successor.weekStartDate === predecessor.weekStartDate
    && successor.bodyProfileVersionId === predecessor.bodyProfileVersionId
    && successor.goalVersionId === predecessor.goalVersionId
    && successor.trainingPlanVersionId === predecessor.trainingPlanVersionId
    && successor.days.length === predecessor.days.length
    && successor.days.every((day, index) => {
      const predecessorDay = predecessor.days[index];
      return predecessorDay !== undefined
        && day.businessDate === predecessorDay.businessDate
        && day.dailyNutritionTargetVersionId
          === predecessorDay.dailyNutritionTargetVersionId;
    });
}

function changedTargetDates(
  plan: MealPlanVersion,
  previousPlan: MealPlanVersion
): Set<string> {
  const previousDays = new Map(
    previousPlan.days.map((day) => [day.businessDate, day])
  );
  const changedDates = new Set<string>();
  for (const day of plan.days) {
    const previousDay = previousDays.get(day.businessDate);
    if (previousDay === undefined) corrupt();
    if (
      previousDay.dailyNutritionTargetVersionId
      !== day.dailyNutritionTargetVersionId
    ) {
      changedDates.add(day.businessDate);
    }
  }
  return changedDates;
}

export function assertPlanningAggregateInvariants(
  state: PlanningAggregateState,
  userId: string
): void {
  const ownedRecords = [
    ...state.bodyProfiles,
    ...state.goals,
    ...state.trainingPlans,
    ...state.dailyEnergyTargets,
    ...state.dailyNutritionTargets,
    ...state.inventories,
    ...state.mealPlans,
    ...state.mealPlanTargetDiffs,
    ...state.mealPlanDecisions,
    ...state.trainingCompletionEvents,
    ...state.recalculationJobs,
    ...state.outboxEvents
  ];
  if (ownedRecords.some((record) => record.userId !== userId)) corrupt();

  const entityIds = [
    ...state.bodyProfiles.map((value) => value.id),
    ...state.goals.map((value) => value.id),
    ...state.trainingPlans.map((value) => value.id),
    ...state.dailyEnergyTargets.map((value) => value.id),
    ...state.dailyNutritionTargets.map((value) => value.id),
    ...state.inventories.map((value) => value.id),
    ...state.mealPlans.map((value) => value.id),
    ...state.mealPlanTargetDiffs.map((value) => value.id),
    ...state.mealPlanDecisions.map((value) => value.id),
    ...state.trainingCompletionEvents.map((value) => value.id),
    ...state.recalculationJobs.map((value) => value.id),
    ...state.outboxEvents.map((event) => event.eventId)
  ];
  assertUnique(entityIds);
  assertUnique(state.idempotencyRecords.map((record) => `${record.operation}\u0000${record.key}`));

  assertContiguous(state.bodyProfiles.map((value) => value.version));
  assertContiguous(state.goals.map((value) => value.version));
  assertContiguous(state.trainingPlans.map((value) => value.version));
  assertContiguous(state.inventories.map((value) => value.version));
  assertContiguous(state.mealPlans.map((value) => value.version));
  assertContiguous(state.mealPlanDecisions.map((value) => value.version));
  assertContiguous(state.trainingCompletionEvents.map((value) => value.version));
  assertContiguousByBusinessDate(state.dailyEnergyTargets);
  assertContiguousByBusinessDate(state.dailyNutritionTargets);

  const bodyProfiles = new Map(state.bodyProfiles.map((value) => [value.id, value]));
  const goals = new Map(state.goals.map((value) => [value.id, value]));
  const trainingPlans = new Map(state.trainingPlans.map((value) => [value.id, value]));
  const dailyTargets = new Map(state.dailyEnergyTargets.map((value) => [value.id, value]));
  const nutritionTargets = new Map(
    state.dailyNutritionTargets.map((value) => [value.id, value])
  );
  const inventories = new Map(state.inventories.map((value) => [value.id, value]));
  const mealPlans = new Map(state.mealPlans.map((value) => [value.id, value]));
  const events = new Map(state.outboxEvents.map((value) => [value.eventId, value]));
  const completions = new Map(
    state.trainingCompletionEvents.map((value) => [value.id, value])
  );
  const inventoryItems = new Map<string, ReadonlyMap<string, InventoryVersion['items'][number]>>();
  for (const inventory of state.inventories) {
    inventoryItems.set(inventory.id, inventoryItemsByFood(inventory));
  }
  const trainingPlanLineage = buildTrainingPlanLineage(trainingPlans, state.outboxEvents);

  for (const goal of state.goals) {
    if (!bodyProfiles.has(goal.bodyProfileVersionId)) corrupt();
  }
  for (const plan of state.trainingPlans) {
    const goal = goals.get(plan.goalVersionId);
    if (
      !bodyProfiles.has(plan.bodyProfileVersionId)
      || goal === undefined
      || goal.bodyProfileVersionId !== plan.bodyProfileVersionId
    ) {
      corrupt();
    }
  }
  for (const target of state.dailyEnergyTargets) {
    const goal = goals.get(target.goalVersionId);
    const plan = trainingPlans.get(target.trainingPlanVersionId);
    if (
      !bodyProfiles.has(target.bodyProfileVersionId)
      || goal === undefined
      || plan === undefined
      || goal.bodyProfileVersionId !== target.bodyProfileVersionId
      || plan.bodyProfileVersionId !== target.bodyProfileVersionId
      || plan.goalVersionId !== target.goalVersionId
    ) {
      corrupt();
    }
  }
  for (const target of state.dailyNutritionTargets) {
    const goal = goals.get(target.goalVersionId);
    const plan = trainingPlans.get(target.trainingPlanVersionId);
    const energyTarget = dailyTargets.get(target.dailyEnergyTargetVersionId);
    if (
      !bodyProfiles.has(target.bodyProfileVersionId)
      || goal === undefined
      || plan === undefined
      || energyTarget === undefined
      || goal.bodyProfileVersionId !== target.bodyProfileVersionId
      || plan.bodyProfileVersionId !== target.bodyProfileVersionId
      || plan.goalVersionId !== target.goalVersionId
      || energyTarget.businessDate !== target.businessDate
      || energyTarget.bodyProfileVersionId !== target.bodyProfileVersionId
      || energyTarget.goalVersionId !== target.goalVersionId
      || energyTarget.trainingPlanVersionId !== target.trainingPlanVersionId
      || JSON.stringify(energyTarget.energy) !== JSON.stringify(target.energy)
    ) {
      corrupt();
    }
  }
  for (const plan of state.mealPlans) {
    assertMealPlan(plan, {
      bodyProfiles,
      goals,
      trainingPlans,
      nutritionTargets,
      inventories,
      mealPlans,
      inventoryItems,
      trainingPlanLineage
    });
  }

  const activeProfile = state.activeBodyProfileVersionId === null
    ? undefined
    : bodyProfiles.get(state.activeBodyProfileVersionId);
  const activeGoal = state.activeGoalVersionId === null
    ? undefined
    : goals.get(state.activeGoalVersionId);
  const activePlan = state.activeTrainingPlanVersionId === null
    ? undefined
    : trainingPlans.get(state.activeTrainingPlanVersionId);
  if (state.activeBodyProfileVersionId !== null && activeProfile === undefined) corrupt();
  if (
    state.activeGoalVersionId !== null
    && (activeGoal === undefined || activeGoal.bodyProfileVersionId !== activeProfile?.id)
  ) {
    corrupt();
  }
  if (
    state.activeTrainingPlanVersionId !== null
    && (
      activePlan === undefined
      || activePlan.bodyProfileVersionId !== activeProfile?.id
      || activePlan.goalVersionId !== activeGoal?.id
    )
  ) {
    corrupt();
  }
  if (
    state.activeInventoryVersionId !== null
    && !inventories.has(state.activeInventoryVersionId)
  ) {
    corrupt();
  }
  const activeMealPlan = state.activeMealPlanVersionId === null
    ? undefined
    : mealPlans.get(state.activeMealPlanVersionId);
  if (
    state.activeMealPlanVersionId !== null
    && (activeMealPlan === undefined || activeMealPlan.readiness !== 'complete')
  ) {
    corrupt();
  }

  for (const event of state.outboxEvents) {
    assertEventDates(event);
    const plan = trainingPlans.get(event.trainingPlanVersionId);
    const goal = goals.get(event.goalVersionId);
    if (
      plan === undefined
      || goal === undefined
      || !bodyProfiles.has(event.bodyProfileVersionId)
      || plan.bodyProfileVersionId !== event.bodyProfileVersionId
      || plan.goalVersionId !== event.goalVersionId
      || goal.bodyProfileVersionId !== event.bodyProfileVersionId
      || (
        event.previousTrainingPlanVersionId !== null
        && !trainingPlans.has(event.previousTrainingPlanVersionId)
      )
    ) {
      corrupt();
    }
  }

  for (const completion of state.trainingCompletionEvents) {
    const plan = trainingPlans.get(completion.trainingPlanVersionId);
    if (
      plan === undefined
      || !plan.payload.sessions.some((session) => session.businessDate === completion.businessDate)
    ) {
      corrupt();
    }
  }

  const expectedDiffsByCandidate = new Map<
    string,
    Map<
      string,
      {
        readonly previousNutritionTargetVersionId: string;
        readonly proposedNutritionTargetVersionId: string;
      }
    >
  >();
  for (const candidate of state.mealPlans) {
    if (candidate.readiness !== 'pending_confirmation') continue;
    const previousPlan = candidate.supersedesVersionId === null
      ? undefined
      : mealPlans.get(candidate.supersedesVersionId);
    if (previousPlan === undefined) corrupt();
    const previousDays = new Map(
      previousPlan.days.map((day) => [day.businessDate, day])
    );
    const expectedDiffs = new Map<
      string,
      {
        readonly previousNutritionTargetVersionId: string;
        readonly proposedNutritionTargetVersionId: string;
      }
    >();
    for (const candidateDay of candidate.days) {
      const previousDay = previousDays.get(candidateDay.businessDate);
      if (previousDay === undefined) corrupt();
      if (
        candidateDay.locked !== previousDay.locked
        || candidateDay.manuallyModified !== previousDay.manuallyModified
      ) {
        corrupt();
      }
      if (
        (previousDay.locked || previousDay.manuallyModified)
        && previousDay.dailyNutritionTargetVersionId
          !== candidateDay.dailyNutritionTargetVersionId
      ) {
        expectedDiffs.set(candidateDay.businessDate, {
          previousNutritionTargetVersionId: previousDay.dailyNutritionTargetVersionId,
          proposedNutritionTargetVersionId: candidateDay.dailyNutritionTargetVersionId
        });
      }
    }
    if (expectedDiffs.size === 0) corrupt();
    expectedDiffsByCandidate.set(candidate.id, expectedDiffs);
  }

  const diffDatesByCandidate = new Map<string, Set<string>>();
  for (const diff of state.mealPlanTargetDiffs) {
    const candidate = mealPlans.get(diff.candidateMealPlanVersionId);
    const expected = candidate === undefined
      ? undefined
      : expectedDiffsByCandidate.get(candidate.id)?.get(diff.businessDate);
    if (
      candidate === undefined
      || candidate.readiness !== 'pending_confirmation'
      || expected === undefined
      || diff.previousNutritionTargetVersionId === diff.proposedNutritionTargetVersionId
      || !nutritionTargets.has(diff.previousNutritionTargetVersionId)
      || !nutritionTargets.has(diff.proposedNutritionTargetVersionId)
      || expected.previousNutritionTargetVersionId
        !== diff.previousNutritionTargetVersionId
      || expected.proposedNutritionTargetVersionId
        !== diff.proposedNutritionTargetVersionId
    ) {
      corrupt();
    }
    const dates = diffDatesByCandidate.get(candidate.id) ?? new Set<string>();
    if (dates.has(diff.businessDate)) corrupt();
    dates.add(diff.businessDate);
    diffDatesByCandidate.set(candidate.id, dates);
  }
  for (const [candidateId, expectedDiffs] of expectedDiffsByCandidate) {
    const actualDates = diffDatesByCandidate.get(candidateId);
    if (
      actualDates === undefined
      || actualDates.size !== expectedDiffs.size
      || [...expectedDiffs.keys()].some((date) => !actualDates.has(date))
    ) {
      corrupt();
    }
  }

  const decisionsByCandidate = new Map<
    string,
    PlanningAggregateState['mealPlanDecisions'][number]
  >();
  for (const decision of state.mealPlanDecisions) {
    const candidate = mealPlans.get(decision.candidateMealPlanVersionId);
    const previous = mealPlans.get(decision.previousActiveMealPlanVersionId);
    const activated = decision.activatedMealPlanVersionId === null
      ? undefined
      : mealPlans.get(decision.activatedMealPlanVersionId);
    if (
      candidate === undefined
      || candidate.readiness !== 'pending_confirmation'
      || previous === undefined
      || previous.readiness !== 'complete'
      || candidate.supersedesVersionId !== previous.id
      || decisionsByCandidate.has(candidate.id)
      || (decision.decision === 'keep_existing' && decision.activatedMealPlanVersionId !== null)
      || (
        decision.decision === 'overwrite_locked'
        && (
          activated === undefined
          || activated.readiness !== 'complete'
          || !isDirectMealPlanSuccessor(activated, candidate)
        )
      )
    ) {
      corrupt();
    }
    decisionsByCandidate.set(candidate.id, decision);
  }

  const triggerEventIds = new Set<string>();
  const jobsByCandidate = new Map<
    string,
    PlanningAggregateState['recalculationJobs'][number]
  >();
  for (const job of state.recalculationJobs) {
    assertSortedUniqueDates(job.affectedDates);
    if (triggerEventIds.has(job.triggerEventId)) corrupt();
    triggerEventIds.add(job.triggerEventId);
    const trigger = job.triggerType === 'training_plan_changed'
      ? events.get(job.triggerEventId)
      : completions.get(job.triggerEventId);
    const candidate = job.candidateMealPlanVersionId === null
      ? undefined
      : mealPlans.get(job.candidateMealPlanVersionId);
    const activated = job.activatedMealPlanVersionId === null
      ? undefined
      : mealPlans.get(job.activatedMealPlanVersionId);
    if (
      trigger === undefined
      || (candidate !== undefined && candidate.readiness !== 'pending_confirmation')
      || (job.candidateMealPlanVersionId !== null && candidate === undefined)
      || (activated !== undefined && activated.readiness !== 'complete')
      || (job.activatedMealPlanVersionId !== null && activated === undefined)
    ) {
      corrupt();
    }
    if (candidate !== undefined) {
      const decision = decisionsByCandidate.get(candidate.id);
      if (
        jobsByCandidate.has(candidate.id)
        || (
          job.status === 'completed'
          && (
            decision === undefined
            || decision.activatedMealPlanVersionId
              !== job.activatedMealPlanVersionId
          )
        )
        || (job.status !== 'completed' && decision !== undefined)
      ) {
        corrupt();
      }
      jobsByCandidate.set(candidate.id, job);
    }
    const triggerTrainingPlanVersionId = job.triggerType === 'training_plan_changed'
      ? events.get(job.triggerEventId)?.trainingPlanVersionId
      : completions.get(job.triggerEventId)?.trainingPlanVersionId;
    const triggerTrainingPlan = triggerTrainingPlanVersionId === undefined
      ? undefined
      : trainingPlans.get(triggerTrainingPlanVersionId);
    if (
      triggerTrainingPlan === undefined
      || (
        candidate !== undefined
        && (
          candidate.trainingPlanVersionId !== triggerTrainingPlan.id
          || candidate.weekStartDate !== triggerTrainingPlan.payload.weekStartDate
        )
      )
      || (
        activated !== undefined
        && (
          activated.trainingPlanVersionId !== triggerTrainingPlan.id
          || activated.weekStartDate !== triggerTrainingPlan.payload.weekStartDate
        )
      )
      || (
        candidate !== undefined
        && activated !== undefined
        && !isDirectMealPlanSuccessor(activated, candidate)
      )
    ) {
      corrupt();
    }
    if (job.triggerType === 'training_plan_changed') {
      const event = events.get(job.triggerEventId);
      if (
        event === undefined
        || event.affectedDates.length !== job.affectedDates.length
        || event.affectedDates.some((date, index) => date !== job.affectedDates[index])
      ) {
        corrupt();
      }
    } else {
      const completion = completions.get(job.triggerEventId);
      if (
        completion === undefined
        || job.affectedDates.length !== 1
        || job.affectedDates[0] !== completion.businessDate
      ) {
        corrupt();
      }
    }
    const resultPlan = candidate ?? activated;
    if (resultPlan !== undefined) {
      const previousPlan = resultPlan.supersedesVersionId === null
        ? undefined
        : mealPlans.get(resultPlan.supersedesVersionId);
      if (previousPlan === undefined) corrupt();
      const changedDates = changedTargetDates(resultPlan, previousPlan);
      if (
        changedDates.size !== job.affectedDates.length
        || job.affectedDates.some((date) => !changedDates.has(date))
      ) {
        corrupt();
      }
      const resultDays = new Map(
        resultPlan.days.map((day) => [day.businessDate, day])
      );
      for (const affectedDate of job.affectedDates) {
        const resultDay = resultDays.get(affectedDate);
        const target = resultDay === undefined
          ? undefined
          : nutritionTargets.get(resultDay.dailyNutritionTargetVersionId);
        if (
          target === undefined
          || target.businessDate !== affectedDate
          || target.trainingPlanVersionId !== triggerTrainingPlan.id
        ) {
          corrupt();
        }
      }
    }
    if (
      (job.status === 'pending'
        && (job.completedAt !== null || job.failureCode !== null || job.activatedMealPlanVersionId !== null))
      || (job.status === 'failed_retryable'
        && (job.completedAt !== null || job.failureCode === null || job.activatedMealPlanVersionId !== null))
      || (job.status === 'completed'
        && (job.completedAt === null || job.failureCode !== null))
    ) {
      corrupt();
    }
  }
  for (const candidateId of decisionsByCandidate.keys()) {
    if (!jobsByCandidate.has(candidateId)) corrupt();
  }
  for (const candidateId of expectedDiffsByCandidate.keys()) {
    if (!jobsByCandidate.has(candidateId)) corrupt();
  }

  const idSets: EntityIds = {
    bodyProfiles: new Set(bodyProfiles.keys()),
    goals: new Set(goals.keys()),
    trainingPlans: new Set(trainingPlans.keys()),
    dailyTargets: new Set(dailyTargets.keys()),
    inventories: new Set(inventories.keys()),
    mealPlans: new Set(mealPlans.keys()),
    mealPlanDecisions: new Set(state.mealPlanDecisions.map((value) => value.id)),
    trainingCompletions: new Set(completions.keys()),
    recalculationJobs: new Set(state.recalculationJobs.map((value) => value.id)),
    events: new Set(events.keys())
  };
  for (const record of state.idempotencyRecords) {
    assertIdempotencyResult(record, idSets, {
      goals,
      trainingPlans,
      dailyTargets,
      events
    });
  }
}

export function parseAndAssertPlanningState(
  state: unknown,
  userId: string
): PlanningAggregateState {
  const parsed = planningAggregateStateSchema.safeParse(state);
  if (!parsed.success) throw new CorruptPlanningStateError();
  assertPlanningAggregateInvariants(parsed.data, userId);
  return parsed.data;
}
