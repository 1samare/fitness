import { addBusinessDays } from '@fitness/contracts';
import { calculateNutritionTargets, findReviewedTrainingSession } from '@fitness/calculation';
import {
  latestIngredientPhotoVersions,
  type BodyProfilePayload,
  type BodyProfileVersion,
  type CompletePlanningSetupCommand,
  type CurrentPlanningContext,
  type DailyEnergyTargetVersion,
  type DailyNutritionTargetVersion,
  type GoalPayload,
  type GoalVersion,
  type IdempotencyRecord,
  type IngredientPhotoVersion,
  type InventoryVersion,
  type MealPlanVersion,
  type PlanningAggregateState,
  type RecalculationJob,
  type TrainingPlanChangedEvent,
  type TrainingPlanPayload,
  type TrainingPlanVersion,
  type WriteCommandEnvelope
} from '@fitness/domain';
import { businessDateAt } from './business-time';
import { requestFingerprint } from './idempotency-fingerprint';
import { previewDailyEnergy } from './preview-daily-energy';
import { PastFactImmutableError } from './planning-errors';
import { affectedTrainingDates } from './training-plan-change';

export interface PlanningRepository {
  read(userId: string): Promise<PlanningAggregateState>;
  transact<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => {
      readonly nextState: PlanningAggregateState;
      readonly result: TResult;
    }
  ): Promise<TResult>;
}

export interface VersionedPlanningServiceDependencies {
  readonly repository: PlanningRepository;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
}

export class VersionConflictError extends Error {
  public readonly code = 'version_conflict' as const;

  public constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number
  ) {
    super(`Expected version ${String(expectedVersion)}, but active version is ${String(actualVersion)}`);
    this.name = 'VersionConflictError';
  }
}

export class IdempotencyKeyReuseError extends Error {
  public readonly code = 'idempotency_key_reused' as const;

  public constructor(public readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for another command`);
    this.name = 'IdempotencyKeyReuseError';
  }
}

export class PlanningPrerequisiteError extends Error {
  public readonly code = 'planning_prerequisite_missing' as const;

  public constructor(
    public readonly prerequisite:
      | 'body_profile'
      | 'goal'
      | 'training_plan'
      | 'inventory'
      | 'daily_nutrition_targets'
  ) {
    super(`Planning prerequisite is missing: ${prerequisite}`);
    this.name = 'PlanningPrerequisiteError';
  }
}

export class InvalidGoalError extends Error {
  public readonly code = 'invalid_goal' as const;

  public constructor(public readonly reason: 'target_bmi_below_supported_floor') {
    super(`Invalid goal: ${reason}`);
    this.name = 'InvalidGoalError';
  }
}

export class InvalidTrainingPlanError extends Error {
  public readonly code = 'invalid_training_plan' as const;

  public constructor(
    public readonly reason:
      | 'date_outside_week'
      | 'duplicate_training_date'
      | 'completion_not_planned'
  ) {
    super(`Invalid training plan: ${reason}`);
    this.name = 'InvalidTrainingPlanError';
  }
}

export class PastTrainingChangeError extends Error {
  public readonly code = 'past_training_change_forbidden' as const;

  public constructor(public readonly businessDate: string) {
    super(`Training changes are forbidden before the eligible business date: ${businessDate}`);
    this.name = 'PastTrainingChangeError';
  }
}

export class TrainingDateOutsideGoalPeriodError extends Error {
  public readonly code = 'training_date_outside_goal_period' as const;

  public constructor(public readonly businessDate: string) {
    super(`Training date is outside the active goal period: ${businessDate}`);
    this.name = 'TrainingDateOutsideGoalPeriodError';
  }
}

export interface SavedTrainingPlan {
  readonly trainingPlan: TrainingPlanVersion;
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
}

export interface SavedPlanningSetup extends SavedTrainingPlan {
  readonly bodyProfile: BodyProfileVersion;
  readonly goal: GoalVersion;
  readonly affectedDates: readonly string[];
}

interface TrainingAppendResult extends SavedTrainingPlan {
  readonly affectedDates: readonly string[];
  readonly event: TrainingPlanChangedEvent;
}

interface AppendContext {
  readonly createdAt: string;
  readonly nextId: (prefix: string) => string;
}

interface StateResult<TResult> {
  readonly nextState: PlanningAggregateState;
  readonly result: TResult;
}

function findById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string | null
): T | null {
  if (id === null) return null;
  return values.find((value) => value.id === id) ?? null;
}

function mostRecentlyCreatedIngredientPhoto(
  photos: readonly IngredientPhotoVersion[]
): IngredientPhotoVersion | null {
  let latest: IngredientPhotoVersion | null = null;
  for (const photo of photos) {
    if (
      latest === null
      || photo.uploadCreatedAt > latest.uploadCreatedAt
      || (photo.uploadCreatedAt === latest.uploadCreatedAt && photo.photoId > latest.photoId)
    ) {
      latest = photo;
    }
  }
  return latest;
}

function deriveMealPlanStale(input: {
  readonly bodyProfile: BodyProfileVersion | null;
  readonly goal: GoalVersion | null;
  readonly trainingPlan: TrainingPlanVersion | null;
  readonly inventory: InventoryVersion | null;
  readonly mealPlan: MealPlanVersion | null;
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
}): boolean {
  if (input.mealPlan === null) return false;
  if (
    input.bodyProfile === null
    || input.goal === null
    || input.trainingPlan === null
    || input.inventory === null
    || input.mealPlan.bodyProfileVersionId !== input.bodyProfile.id
    || input.mealPlan.goalVersionId !== input.goal.id
    || input.mealPlan.trainingPlanVersionId !== input.trainingPlan.id
    || input.mealPlan.inventoryVersionId !== input.inventory.id
  ) return true;
  const currentTargetIds = input.dailyNutritionTargets.map((target) => target.id).sort();
  const mealPlanTargetIds = input.mealPlan.days
    .map((day) => day.dailyNutritionTargetVersionId)
    .sort();
  return mealPlanTargetIds.length !== currentTargetIds.length
    || mealPlanTargetIds.some((id, index) => id !== currentTargetIds[index]);
}

function fingerprint<T>(envelope: WriteCommandEnvelope<T>): string {
  return requestFingerprint({
    expectedVersion: envelope.expectedVersion,
    payload: envelope.payload
  });
}

function setupFingerprint(command: CompletePlanningSetupCommand): string {
  return requestFingerprint({
    expectedVersions: command.expectedVersions,
    bodyProfile: command.bodyProfile,
    goal: command.goal,
    trainingPlan: command.trainingPlan
  });
}

function findIdempotencyRecord<TOperation extends IdempotencyRecord['operation']>(
  state: PlanningAggregateState,
  operation: TOperation,
  key: string
): Extract<IdempotencyRecord, { readonly operation: TOperation }> | undefined {
  return state.idempotencyRecords.find(
    (record): record is Extract<IdempotencyRecord, { readonly operation: TOperation }> => (
      record.operation === operation && record.key === key
    )
  );
}

function assertReplay(
  record: IdempotencyRecord,
  expectedFingerprint: string,
  idempotencyKey: string
): void {
  if (record.requestFingerprint !== expectedFingerprint) {
    throw new IdempotencyKeyReuseError(idempotencyKey);
  }
}

function assertExpectedVersion(expectedVersion: number, actualVersion: number): void {
  if (expectedVersion !== actualVersion) {
    throw new VersionConflictError(expectedVersion, actualVersion);
  }
}

function weekBusinessDates(startDate: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addBusinessDays(startDate, index));
}

function assertTrainingDates(payload: TrainingPlanPayload, weekDates: readonly string[]): void {
  const seenDates = new Set<string>();
  for (const session of payload.sessions) {
    if (!weekDates.includes(session.businessDate)) {
      throw new InvalidTrainingPlanError('date_outside_week');
    }
    if (seenDates.has(session.businessDate)) {
      throw new InvalidTrainingPlanError('duplicate_training_date');
    }
    seenDates.add(session.businessDate);
  }
}

function assertGoal(profile: BodyProfileVersion, payload: GoalPayload): void {
  if (payload.goal !== 'fat_loss' || payload.targetWeightKg === undefined) return;
  const heightM = profile.payload.heightCm / 100;
  const targetBmi = payload.targetWeightKg / (heightM * heightM);
  if (targetBmi < 18.5) {
    throw new InvalidGoalError('target_bmi_below_supported_floor');
  }
}

function appendBodyProfile(
  state: PlanningAggregateState,
  userId: string,
  payload: BodyProfilePayload,
  expectedVersion: number,
  context: AppendContext
): StateResult<BodyProfileVersion> {
  const actualVersion = state.bodyProfiles.length;
  assertExpectedVersion(expectedVersion, actualVersion);
  const version: BodyProfileVersion = {
    kind: 'body_profile_version',
    id: context.nextId('body-profile'),
    userId,
    version: actualVersion + 1,
    createdAt: context.createdAt,
    payload
  };
  return {
    nextState: {
      ...state,
      bodyProfiles: [...state.bodyProfiles, version],
      activeBodyProfileVersionId: version.id,
      activeGoalVersionId: null,
      activeTrainingPlanVersionId: null
    },
    result: version
  };
}

function appendGoal(
  state: PlanningAggregateState,
  userId: string,
  payload: GoalPayload,
  expectedVersion: number,
  context: AppendContext
): StateResult<GoalVersion> {
  const profile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  if (profile === null) throw new PlanningPrerequisiteError('body_profile');
  const actualVersion = state.goals.length;
  assertExpectedVersion(expectedVersion, actualVersion);
  assertGoal(profile, payload);
  const version: GoalVersion = {
    kind: 'goal_version',
    id: context.nextId('goal'),
    userId,
    version: actualVersion + 1,
    createdAt: context.createdAt,
    bodyProfileVersionId: profile.id,
    payload
  };
  return {
    nextState: {
      ...state,
      goals: [...state.goals, version],
      activeGoalVersionId: version.id,
      activeTrainingPlanVersionId: null
    },
    result: version
  };
}

function eligibleWeekDates(input: {
  readonly weekDates: readonly string[];
  readonly businessToday: string;
  readonly goal: GoalVersion;
}): string[] {
  const eligibleStart = [
    input.weekDates[0] ?? input.businessToday,
    input.businessToday,
    input.goal.payload.effectiveDate
  ].sort().at(-1);
  if (eligibleStart === undefined) return [];
  return input.weekDates.filter(
    (date) => date >= eligibleStart && date <= input.goal.payload.targetDate
  );
}

function assertChangedDatesEligible(
  changedDates: readonly string[],
  eligibleDates: readonly string[],
  goal: GoalVersion
): void {
  const eligible = new Set(eligibleDates);
  for (const date of changedDates) {
    if (eligible.has(date)) continue;
    if (date > goal.payload.targetDate) {
      throw new TrainingDateOutsideGoalPeriodError(date);
    }
    throw new PastTrainingChangeError(date);
  }
}

function appendTrainingPlan(
  state: PlanningAggregateState,
  userId: string,
  payload: TrainingPlanPayload,
  expectedVersion: number,
  context: AppendContext
): StateResult<TrainingAppendResult> {
  const profile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  if (profile === null) throw new PlanningPrerequisiteError('body_profile');
  const goal = findById(state.goals, state.activeGoalVersionId);
  if (goal === null || goal.bodyProfileVersionId !== profile.id) {
    throw new PlanningPrerequisiteError('goal');
  }
  const actualVersion = state.trainingPlans.length;
  assertExpectedVersion(expectedVersion, actualVersion);

  const weekDates = weekBusinessDates(payload.weekStartDate);
  assertTrainingDates(payload, weekDates);
  const businessToday = businessDateAt(context.createdAt, payload.businessTimezone);
  const eligibleDates = eligibleWeekDates({ weekDates, businessToday, goal });
  const previous = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  const isSameWeek = previous?.payload.weekStartDate === payload.weekStartDate;
  const previousSessions = isSameWeek ? previous.payload.sessions : [];
  const changedDates = affectedTrainingDates(previousSessions, payload.sessions, weekDates);
  const completedDates = new Set(
    state.trainingCompletionEvents.map((completion) => completion.businessDate)
  );
  const immutableFactDate = changedDates.find((date) => completedDates.has(date));
  if (immutableFactDate !== undefined) throw new PastFactImmutableError(immutableFactDate);
  assertChangedDatesEligible(changedDates, eligibleDates, goal);
  const affectedDates = isSameWeek
    ? affectedTrainingDates(previousSessions, payload.sessions, eligibleDates)
    : eligibleDates;

  const trainingPlan: TrainingPlanVersion = {
    kind: 'training_plan_version',
    id: context.nextId('training-plan'),
    userId,
    version: actualVersion + 1,
    createdAt: context.createdAt,
    bodyProfileVersionId: profile.id,
    goalVersionId: goal.id,
    payload
  };
  const dailyEnergyTargets = affectedDates.map((businessDate) => {
    const session = payload.sessions.find(
      (candidate) => candidate.businessDate === businessDate
    );
    const energy = previewDailyEnergy({
      ageYears: profile.payload.ageYears,
      sexCode: profile.payload.sexCode,
      heightCm: profile.payload.heightCm,
      weightKg: profile.payload.weightKg,
      healthScopeConfirmed: profile.payload.healthScopeConfirmed,
      nonTrainingActivity: profile.payload.nonTrainingActivity,
      goal: goal.payload.goal,
      ...(session === undefined
        ? {}
        : {
            training: {
              sessionCode: session.sessionCode,
              durationMinutes: session.durationMinutes
            }
          })
    });
    const version: DailyEnergyTargetVersion = {
      kind: 'daily_energy_target_version',
      id: context.nextId('daily-energy-target'),
      userId,
      version: state.dailyEnergyTargets.filter(
        (target) => target.businessDate === businessDate
      ).length + 1,
      createdAt: context.createdAt,
      businessDate,
      bodyProfileVersionId: profile.id,
      goalVersionId: goal.id,
      trainingPlanVersionId: trainingPlan.id,
      energyPolicyVersion: 'calculation-policy-v2',
      nutritionPolicyVersion: 'nutrition-policy-v1',
      energy
    };
    return version;
  });
  const dailyNutritionTargets = dailyEnergyTargets.map((dailyEnergyTarget) => {
    const session = payload.sessions.find(
      (candidate) => candidate.businessDate === dailyEnergyTarget.businessDate
    );
    const reviewedSession = session === undefined
      ? undefined
      : findReviewedTrainingSession(session.sessionCode);
    const nutrition = dailyEnergyTarget.energy.kind === 'supported'
      ? calculateNutritionTargets({
          targetEnergyKcal: dailyEnergyTarget.energy.targetEnergyKcal,
          weightKg: profile.payload.weightKg,
          sexCode: profile.payload.sexCode,
          goal: goal.payload.goal,
          trainingKind: reviewedSession?.trainingKind ?? 'none'
        })
      : null;
    const version: DailyNutritionTargetVersion = {
      kind: 'daily_nutrition_target_version',
      id: context.nextId('daily-nutrition-target'),
      userId,
      version: state.dailyNutritionTargets.filter(
        (target) => target.businessDate === dailyEnergyTarget.businessDate
      ).length + 1,
      createdAt: context.createdAt,
      businessDate: dailyEnergyTarget.businessDate,
      bodyProfileVersionId: profile.id,
      goalVersionId: goal.id,
      trainingPlanVersionId: trainingPlan.id,
      dailyEnergyTargetVersionId: dailyEnergyTarget.id,
      energyPolicyVersion: 'calculation-policy-v2',
      nutritionPolicyVersion: 'nutrition-policy-v1',
      energy: dailyEnergyTarget.energy,
      nutrition
    };
    return version;
  });
  const event: TrainingPlanChangedEvent = {
    eventId: context.nextId('training-plan-change'),
    eventType: 'TrainingPlanChanged',
    userId,
    previousTrainingPlanVersionId: previous?.id ?? null,
    trainingPlanVersionId: trainingPlan.id,
    bodyProfileVersionId: profile.id,
    goalVersionId: goal.id,
    affectedDates,
    occurredAt: context.createdAt,
    status: 'pending'
  };
  return {
    nextState: {
      ...state,
      trainingPlans: [...state.trainingPlans, trainingPlan],
      dailyEnergyTargets: [...state.dailyEnergyTargets, ...dailyEnergyTargets],
      dailyNutritionTargets: [
        ...state.dailyNutritionTargets,
        ...dailyNutritionTargets
      ],
      outboxEvents: [...state.outboxEvents, event],
      activeTrainingPlanVersionId: trainingPlan.id
    },
    result: {
      trainingPlan,
      dailyEnergyTargets,
      dailyNutritionTargets,
      affectedDates,
      event
    }
  };
}

function resolveCompositeReplay(
  state: PlanningAggregateState,
  record: Extract<IdempotencyRecord, { readonly operation: 'completePlanningSetup' }>
): SavedPlanningSetup {
  const bodyProfile = findById(state.bodyProfiles, record.resultVersionIds.bodyProfileVersionId);
  const goal = findById(state.goals, record.resultVersionIds.goalVersionId);
  const trainingPlan = findById(
    state.trainingPlans,
    record.resultVersionIds.trainingPlanVersionId
  );
  const dailyEnergyTargets = record.resultVersionIds.dailyEnergyTargetVersionIds.map((id) => {
    const target = findById(state.dailyEnergyTargets, id);
    if (target === null) throw new Error('Stored idempotency result is missing');
    return target;
  });
  const energyTargetIds = new Set(dailyEnergyTargets.map((target) => target.id));
  const dailyNutritionTargets = state.dailyNutritionTargets.filter((target) => (
    energyTargetIds.has(target.dailyEnergyTargetVersionId)
  ));
  const event = state.outboxEvents.find(
    (candidate) => candidate.eventId === record.resultVersionIds.eventId
  );
  if (bodyProfile === null || goal === null || trainingPlan === null || event === undefined) {
    throw new Error('Stored idempotency result is missing');
  }
  return {
    bodyProfile,
    goal,
    trainingPlan,
    dailyEnergyTargets,
    dailyNutritionTargets,
    affectedDates: event.affectedDates
  };
}

function latestTargetsForActivePlan(
  state: PlanningAggregateState,
  profile: BodyProfileVersion,
  goal: GoalVersion,
  trainingPlan: TrainingPlanVersion
): DailyEnergyTargetVersion[] {
  const dates = weekBusinessDates(trainingPlan.payload.weekStartDate);
  const relatedPlanIds = new Set(
    state.trainingPlans
      .filter((candidate) => (
        candidate.bodyProfileVersionId === profile.id
        && candidate.goalVersionId === goal.id
        && candidate.payload.weekStartDate === trainingPlan.payload.weekStartDate
      ))
      .map((candidate) => candidate.id)
  );
  return dates.flatMap((businessDate) => {
    const latest = state.dailyEnergyTargets
      .filter((target) => (
        target.businessDate === businessDate
        && target.bodyProfileVersionId === profile.id
        && target.goalVersionId === goal.id
        && relatedPlanIds.has(target.trainingPlanVersionId)
      ))
      .sort((left, right) => right.version - left.version)[0];
    return latest === undefined ? [] : [latest];
  });
}

function recalculationTriggerTrainingPlanVersionId(
  state: PlanningAggregateState,
  job: RecalculationJob
): string | undefined {
  return job.triggerType === 'training_plan_changed'
    ? state.outboxEvents.find((event) => event.eventId === job.triggerEventId)?.trainingPlanVersionId
    : state.trainingCompletionEvents.find((event) => event.id === job.triggerEventId)
      ?.trainingPlanVersionId;
}

export function recalculationJobMatchesActiveTrainingChain(
  state: PlanningAggregateState,
  job: RecalculationJob
): boolean {
  const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  const bodyProfile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  const goal = findById(state.goals, state.activeGoalVersionId);
  if (
    trainingPlan === null
    || bodyProfile === null
    || goal === null
    || trainingPlan.bodyProfileVersionId !== bodyProfile.id
    || trainingPlan.goalVersionId !== goal.id
    || goal.bodyProfileVersionId !== bodyProfile.id
    || recalculationTriggerTrainingPlanVersionId(state, job) !== trainingPlan.id
  ) {
    return false;
  }
  const weekDates = new Set(
    Array.from({ length: 7 }, (_unused, index) => (
      addBusinessDays(trainingPlan.payload.weekStartDate, index)
    ))
  );
  return job.affectedDates.length > 0
    && job.affectedDates.every((businessDate) => weekDates.has(businessDate));
}

function latestRecalculationJobForActiveTrainingChain(
  state: PlanningAggregateState
): RecalculationJob | null {
  const matchingJobs = state.recalculationJobs.filter((job) => (
    recalculationJobMatchesActiveTrainingChain(state, job)
  ));
  return matchingJobs[matchingJobs.length - 1] ?? null;
}

export function recalculationJobHasCurrentProcessPrerequisites(
  state: PlanningAggregateState,
  job: RecalculationJob
): boolean {
  const matchingJobs = state.recalculationJobs.filter((candidate) => candidate.id === job.id);
  const latestActiveChainJob = latestRecalculationJobForActiveTrainingChain(state);
  if (matchingJobs.length !== 1 || latestActiveChainJob?.id !== job.id) return false;
  const bodyProfile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  const goal = findById(state.goals, state.activeGoalVersionId);
  const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  const inventory = findById(state.inventories, state.activeInventoryVersionId);
  const mealPlan = findById(state.mealPlans, state.activeMealPlanVersionId);
  if (
    bodyProfile === null
    || goal === null
    || trainingPlan === null
    || inventory === null
    || mealPlan === null
    || mealPlan.readiness !== 'complete'
  ) return false;
  const energyTargets = latestTargetsForActivePlan(state, bodyProfile, goal, trainingPlan);
  const nutritionTargets = nutritionTargetsForEnergyTargets(state, energyTargets);
  return energyTargets.length === 7
    && energyTargets.every((target) => target.energy.kind === 'supported')
    && nutritionTargets.length === 7
    && nutritionTargets.every((target) => (
      target.nutrition !== null && target.nutrition.kind === 'feasible'
    ));
}

export function recalculationJobCanRetryForCurrentContext(
  state: PlanningAggregateState,
  job: RecalculationJob
): boolean {
  return job.status === 'failed_retryable'
    && job.candidateMealPlanVersionId === null
    && recalculationJobHasCurrentProcessPrerequisites(state, job);
}

export function pendingMealPlanCandidateMatchesCurrentContext(
  state: PlanningAggregateState,
  candidate: MealPlanVersion
): boolean {
  const matchingJobs = state.recalculationJobs.filter(
    (job) => job.candidateMealPlanVersionId === candidate.id
  );
  const job = matchingJobs[0];
  const bodyProfile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  const goal = findById(state.goals, state.activeGoalVersionId);
  const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  const inventory = findById(state.inventories, state.activeInventoryVersionId);
  const activeMealPlan = findById(state.mealPlans, state.activeMealPlanVersionId);
  const latestActiveChainJob = latestRecalculationJobForActiveTrainingChain(state);
  if (
    matchingJobs.length !== 1
    || job === undefined
    || latestActiveChainJob?.id !== job.id
    || job.status === 'completed'
    || candidate.readiness !== 'pending_confirmation'
    || candidate.supersedesVersionId !== state.activeMealPlanVersionId
    || bodyProfile === null
    || goal === null
    || trainingPlan === null
    || inventory === null
    || activeMealPlan === null
    || candidate.bodyProfileVersionId !== bodyProfile.id
    || candidate.goalVersionId !== goal.id
    || candidate.trainingPlanVersionId !== trainingPlan.id
    || candidate.inventoryVersionId !== inventory.id
    || candidate.weekStartDate !== trainingPlan.payload.weekStartDate
    || !recalculationJobMatchesActiveTrainingChain(state, job)
  ) return false;
  const latestEnergyTargets = latestTargetsForActivePlan(
    state,
    bodyProfile,
    goal,
    trainingPlan
  );
  const latestNutritionTargets = nutritionTargetsForEnergyTargets(state, latestEnergyTargets);
  const latestTargetIdByDate = new Map(
    latestNutritionTargets.map((target) => [target.businessDate, target.id])
  );
  const activeTargetIdByDate = new Map(
    activeMealPlan.days.map((day) => [day.businessDate, day.dailyNutritionTargetVersionId])
  );
  const affectedDates = new Set(job.affectedDates);
  if (
    candidate.days.length !== 7
    || activeTargetIdByDate.size !== 7
    || affectedDates.size !== job.affectedDates.length
  ) return false;
  return candidate.days.every((day) => {
    const expectedTargetId = affectedDates.has(day.businessDate)
      ? latestTargetIdByDate.get(day.businessDate)
      : activeTargetIdByDate.get(day.businessDate);
    return expectedTargetId !== undefined
      && day.dailyNutritionTargetVersionId === expectedTargetId;
  }) && job.affectedDates.every((businessDate) => (
    candidate.days.some((day) => day.businessDate === businessDate)
  ));
}

function nutritionTargetsForEnergyTargets(
  state: PlanningAggregateState,
  energyTargets: readonly DailyEnergyTargetVersion[]
): DailyNutritionTargetVersion[] {
  const byEnergyTargetId = new Map(
    state.dailyNutritionTargets.map((target) => [target.dailyEnergyTargetVersionId, target])
  );
  return energyTargets.flatMap((energyTarget) => {
    const nutritionTarget = byEnergyTargetId.get(energyTarget.id);
    return nutritionTarget === undefined ? [] : [nutritionTarget];
  });
}

export function currentPlanningContextFromState(
  state: PlanningAggregateState
): CurrentPlanningContext {
  const bodyProfile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
  const candidateGoal = findById(state.goals, state.activeGoalVersionId);
  const goal = bodyProfile !== null && candidateGoal?.bodyProfileVersionId === bodyProfile.id
    ? candidateGoal
    : null;
  const candidatePlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  const trainingPlan = bodyProfile !== null
    && goal !== null
    && candidatePlan?.bodyProfileVersionId === bodyProfile.id
    && candidatePlan.goalVersionId === goal.id
    ? candidatePlan
    : null;
  const dailyEnergyTargets = bodyProfile === null || goal === null || trainingPlan === null
    ? []
    : latestTargetsForActivePlan(state, bodyProfile, goal, trainingPlan);
  const dailyNutritionTargets = nutritionTargetsForEnergyTargets(state, dailyEnergyTargets);
  const inventory = findById(state.inventories, state.activeInventoryVersionId);
  const mealPlan = findById(state.mealPlans, state.activeMealPlanVersionId);
  const decidedCandidateIds = new Set(
    state.mealPlanDecisions.map((decision) => decision.candidateMealPlanVersionId)
  );
  const pendingMealPlanCandidate = [...state.mealPlans]
    .filter((candidate) => (
      pendingMealPlanCandidateMatchesCurrentContext(state, candidate)
      && !decidedCandidateIds.has(candidate.id)
    ))
    .sort((left, right) => right.version - left.version)[0] ?? null;
  const mealPlanStale = deriveMealPlanStale({
    bodyProfile,
    goal,
    trainingPlan,
    inventory,
    mealPlan,
    dailyNutritionTargets
  });
  const retryableRecalculationJob = [...state.recalculationJobs]
    .reverse()
    .find((job) => (
      job.status === 'failed_retryable'
      && recalculationJobCanRetryForCurrentContext(state, job)
    )) ?? null;
  const latestIngredientPhotos = latestIngredientPhotoVersions(state.ingredientPhotoVersions);
  const ingredientPhoto = mostRecentlyCreatedIngredientPhoto(latestIngredientPhotos);
  return {
    bodyProfile,
    goal,
    trainingPlan,
    dailyEnergyTargets,
    dailyNutritionTargets,
    inventory,
    mealPlan,
    mealPlanStale,
    pendingMealPlanCandidate,
    pendingMealPlanTargetDiffs: pendingMealPlanCandidate === null
      ? []
      : state.mealPlanTargetDiffs.filter((diff) => (
          diff.candidateMealPlanVersionId === pendingMealPlanCandidate.id
        )),
    selectableRecipes: [],
    selectableRecipesStatus: 'no_options',
    retryableRecalculationJob,
    ingredientPhoto,
    latestVersions: {
      bodyProfile: state.bodyProfiles.length,
      goal: state.goals.length,
      trainingPlan: state.trainingPlans.length,
      inventory: state.inventories.length,
      mealPlan: state.mealPlans.length,
      mealPlanDecision: state.mealPlanDecisions.length,
      trainingCompletion: state.trainingCompletionEvents.length,
      recalculationJob: state.recalculationJobs.length,
      ingredientPhoto: latestIngredientPhotos.length
    }
  };
}

export function createVersionedPlanningService(
  dependencies: VersionedPlanningServiceDependencies
) {
  const { repository, now, nextId } = dependencies;

  return {
    async saveBodyProfile(
      userId: string,
      envelope: WriteCommandEnvelope<BodyProfilePayload>
    ): Promise<BodyProfileVersion> {
      const expectedFingerprint = fingerprint(envelope);
      return repository.transact(userId, (state) => {
        const replay = findIdempotencyRecord(
          state,
          'saveBodyProfile',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          const previous = findById(state.bodyProfiles, replay.resultVersionId);
          if (previous === null) throw new Error('Stored idempotency result is missing');
          return { nextState: state, result: previous };
        }
        const appended = appendBodyProfile(
          state,
          userId,
          envelope.payload,
          envelope.expectedVersion,
          { createdAt: now(), nextId }
        );
        const record: IdempotencyRecord = {
          operation: 'saveBodyProfile',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: appended.result.id
        };
        return {
          nextState: {
            ...appended.nextState,
            idempotencyRecords: [...appended.nextState.idempotencyRecords, record]
          },
          result: appended.result
        };
      });
    },

    async saveGoal(
      userId: string,
      envelope: WriteCommandEnvelope<GoalPayload>
    ): Promise<GoalVersion> {
      const expectedFingerprint = fingerprint(envelope);
      return repository.transact(userId, (state) => {
        const replay = findIdempotencyRecord(state, 'saveGoal', envelope.idempotencyKey);
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          const previous = findById(state.goals, replay.resultVersionId);
          if (previous === null) throw new Error('Stored idempotency result is missing');
          return { nextState: state, result: previous };
        }
        const appended = appendGoal(
          state,
          userId,
          envelope.payload,
          envelope.expectedVersion,
          { createdAt: now(), nextId }
        );
        const record: IdempotencyRecord = {
          operation: 'saveGoal',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: appended.result.id
        };
        return {
          nextState: {
            ...appended.nextState,
            idempotencyRecords: [...appended.nextState.idempotencyRecords, record]
          },
          result: appended.result
        };
      });
    },

    async saveTrainingPlan(
      userId: string,
      envelope: WriteCommandEnvelope<TrainingPlanPayload>
    ): Promise<SavedTrainingPlan> {
      const expectedFingerprint = fingerprint(envelope);
      return repository.transact(userId, (state) => {
        const replay = findIdempotencyRecord(
          state,
          'saveTrainingPlan',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
          const previous = findById(state.trainingPlans, replay.resultVersionId);
          if (previous === null) throw new Error('Stored idempotency result is missing');
          return {
            nextState: state,
            result: {
              trainingPlan: previous,
              dailyEnergyTargets: state.dailyEnergyTargets.filter(
                (target) => target.trainingPlanVersionId === previous.id
              ),
              dailyNutritionTargets: state.dailyNutritionTargets.filter(
                (target) => target.trainingPlanVersionId === previous.id
              )
            }
          };
        }
        const appended = appendTrainingPlan(
          state,
          userId,
          envelope.payload,
          envelope.expectedVersion,
          { createdAt: now(), nextId }
        );
        const record: IdempotencyRecord = {
          operation: 'saveTrainingPlan',
          key: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionId: appended.result.trainingPlan.id
        };
        const job: RecalculationJob = {
          kind: 'recalculation_job',
          id: nextId('recalculation-job'),
          userId,
          triggerEventId: appended.result.event.eventId,
          triggerType: 'training_plan_changed',
          affectedDates: appended.result.affectedDates,
          status: 'pending',
          createdAt: appended.result.event.occurredAt,
          completedAt: null,
          candidateMealPlanVersionId: null,
          activatedMealPlanVersionId: null,
          failureCode: null,
          failureConflictDetailsStatus: 'complete',
          failureConflicts: []
        };
        return {
          nextState: {
            ...appended.nextState,
            recalculationJobs: [...appended.nextState.recalculationJobs, job],
            idempotencyRecords: [...appended.nextState.idempotencyRecords, record]
          },
          result: {
            trainingPlan: appended.result.trainingPlan,
            dailyEnergyTargets: appended.result.dailyEnergyTargets,
            dailyNutritionTargets: appended.result.dailyNutritionTargets
          }
        };
      });
    },

    async completePlanningSetup(
      userId: string,
      command: CompletePlanningSetupCommand
    ): Promise<SavedPlanningSetup> {
      const expectedFingerprint = setupFingerprint(command);
      return repository.transact(userId, (state) => {
        const replay = findIdempotencyRecord(
          state,
          'completePlanningSetup',
          command.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, expectedFingerprint, command.idempotencyKey);
          return { nextState: state, result: resolveCompositeReplay(state, replay) };
        }

        const context = { createdAt: now(), nextId };
        const profile = appendBodyProfile(
          state,
          userId,
          command.bodyProfile,
          command.expectedVersions.bodyProfile,
          context
        );
        const goal = appendGoal(
          profile.nextState,
          userId,
          command.goal,
          command.expectedVersions.goal,
          context
        );
        const training = appendTrainingPlan(
          goal.nextState,
          userId,
          command.trainingPlan,
          command.expectedVersions.trainingPlan,
          context
        );
        const record: IdempotencyRecord = {
          operation: 'completePlanningSetup',
          key: command.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          resultVersionIds: {
            bodyProfileVersionId: profile.result.id,
            goalVersionId: goal.result.id,
            trainingPlanVersionId: training.result.trainingPlan.id,
            dailyEnergyTargetVersionIds: training.result.dailyEnergyTargets.map(
              (target) => target.id
            ),
            eventId: training.result.event.eventId
          }
        };
        return {
          nextState: {
            ...training.nextState,
            idempotencyRecords: [...training.nextState.idempotencyRecords, record]
          },
          result: {
            bodyProfile: profile.result,
            goal: goal.result,
            trainingPlan: training.result.trainingPlan,
            dailyEnergyTargets: training.result.dailyEnergyTargets,
            dailyNutritionTargets: training.result.dailyNutritionTargets,
            affectedDates: training.result.affectedDates
          }
        };
      });
    },

    async getCurrentContext(userId: string): Promise<CurrentPlanningContext> {
      return currentPlanningContextFromState(await repository.read(userId));
    }
  };
}
