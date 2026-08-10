import type {
  IdempotencyRecord,
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
  const ordered = [...versions].sort((left, right) => left - right);
  if (ordered.some((version, index) => version !== index + 1)) corrupt();
}

function assertSortedUniqueDates(event: TrainingPlanChangedEvent): void {
  assertUnique(event.affectedDates);
  const ordered = [...event.affectedDates].sort();
  if (event.affectedDates.some((date, index) => date !== ordered[index])) corrupt();
}

function assertIdempotencyResult(
  record: IdempotencyRecord,
  state: PlanningAggregateState,
  entityIds: {
    readonly bodyProfiles: ReadonlySet<string>;
    readonly goals: ReadonlySet<string>;
    readonly trainingPlans: ReadonlySet<string>;
    readonly dailyTargets: ReadonlySet<string>;
    readonly events: ReadonlySet<string>;
  }
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
  const goal = state.goals.find((candidate) => candidate.id === result.goalVersionId);
  const plan = state.trainingPlans.find(
    (candidate) => candidate.id === result.trainingPlanVersionId
  );
  const event = state.outboxEvents.find((candidate) => candidate.eventId === result.eventId);
  const targets = state.dailyEnergyTargets.filter((candidate) => (
    result.dailyEnergyTargetVersionIds.includes(candidate.id)
  ));
  if (
    goal?.bodyProfileVersionId !== result.bodyProfileVersionId
    || plan?.bodyProfileVersionId !== result.bodyProfileVersionId
    || plan.goalVersionId !== result.goalVersionId
    || event?.trainingPlanVersionId !== result.trainingPlanVersionId
    || event.bodyProfileVersionId !== result.bodyProfileVersionId
    || event.goalVersionId !== result.goalVersionId
    || targets.some((target) => (
      target.bodyProfileVersionId !== result.bodyProfileVersionId
      || target.goalVersionId !== result.goalVersionId
      || target.trainingPlanVersionId !== result.trainingPlanVersionId
    ))
  ) {
    corrupt();
  }
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
    ...state.outboxEvents
  ];
  if (ownedRecords.some((record) => record.userId !== userId)) corrupt();

  const versionIds = [
    ...state.bodyProfiles.map((value) => value.id),
    ...state.goals.map((value) => value.id),
    ...state.trainingPlans.map((value) => value.id),
    ...state.dailyEnergyTargets.map((value) => value.id),
    ...state.dailyNutritionTargets.map((value) => value.id)
  ];
  assertUnique(versionIds);
  assertUnique(state.outboxEvents.map((event) => event.eventId));
  assertUnique(state.idempotencyRecords.map((record) => `${record.operation}\u0000${record.key}`));

  assertContiguous(state.bodyProfiles.map((value) => value.version));
  assertContiguous(state.goals.map((value) => value.version));
  assertContiguous(state.trainingPlans.map((value) => value.version));
  const targetDates = new Set(state.dailyEnergyTargets.map((target) => target.businessDate));
  for (const businessDate of targetDates) {
    assertContiguous(
      state.dailyEnergyTargets
        .filter((target) => target.businessDate === businessDate)
        .map((target) => target.version)
    );
  }
  const nutritionTargetDates = new Set(
    state.dailyNutritionTargets.map((target) => target.businessDate)
  );
  for (const businessDate of nutritionTargetDates) {
    assertContiguous(
      state.dailyNutritionTargets
        .filter((target) => target.businessDate === businessDate)
        .map((target) => target.version)
    );
  }

  const bodyProfiles = new Map(state.bodyProfiles.map((value) => [value.id, value]));
  const goals = new Map(state.goals.map((value) => [value.id, value]));
  const trainingPlans = new Map(state.trainingPlans.map((value) => [value.id, value]));
  const dailyTargets = new Map(state.dailyEnergyTargets.map((value) => [value.id, value]));
  const events = new Map(state.outboxEvents.map((value) => [value.eventId, value]));

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

  for (const event of state.outboxEvents) {
    assertSortedUniqueDates(event);
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

  const entityIds = {
    bodyProfiles: new Set(bodyProfiles.keys()),
    goals: new Set(goals.keys()),
    trainingPlans: new Set(trainingPlans.keys()),
    dailyTargets: new Set(dailyTargets.keys()),
    events: new Set(events.keys())
  };
  for (const record of state.idempotencyRecords) {
    assertIdempotencyResult(record, state, entityIds);
  }
}
