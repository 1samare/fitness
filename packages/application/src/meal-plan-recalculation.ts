import { calculateNutritionTargets, findReviewedTrainingSession, generateWeeklyMealPlan } from '@fitness/calculation';
import type {
  DailyEnergyTargetVersion,
  DailyNutritionTargetVersion,
  IdempotencyRecord,
  MealPlanDecision,
  MealPlanDay,
  MealPlanTargetDiff,
  MealPlanVersion,
  PlanningAggregateState,
  RecalculationJob,
  TrainingCompletionEvent,
  TrainingSessionPayload,
  WriteCommandEnvelope
} from '@fitness/domain';
import { businessDateAt } from './business-time';
import { requestFingerprint } from './idempotency-fingerprint';
import {
  NutritionConstraintsInfeasibleError,
  ProviderUnavailableError,
  generationPrerequisites,
  loadProviderSnapshot,
  providerSnapshotToken,
  withReviewedFoodNames,
  type MealPlanGenerationServiceDependencies
} from './meal-plan-generation';
import { createMealPlanEditingService } from './meal-plan-editing';
import { previewDailyEnergy } from './preview-daily-energy';
import { affectedTrainingDates } from './training-plan-change';
import {
  IdempotencyKeyReuseError,
  InvalidTrainingPlanError,
  PlanningPrerequisiteError,
  VersionConflictError,
  pendingMealPlanCandidateMatchesCurrentContext,
  recalculationJobCanRetryForCurrentContext,
  recalculationJobHasCurrentProcessPrerequisites,
  type SavedTrainingPlan
} from './versioned-planning';
import { FutureCompletionForbiddenError } from './planning-errors';

export type MealPlanRecalculationServiceDependencies = MealPlanGenerationServiceDependencies;

export class CandidateNotPendingError extends Error {
  public readonly code = 'candidate_not_pending' as const;

  public constructor(public readonly candidateMealPlanVersionId: string) {
    super(`Meal plan candidate is not pending: ${candidateMealPlanVersionId}`);
    this.name = 'CandidateNotPendingError';
  }
}

export class CandidateDiffUnavailableError extends Error {
  public readonly code = 'candidate_diff_unavailable' as const;

  public constructor(public readonly candidateMealPlanVersionId: string) {
    super(`Meal plan candidate diff is unavailable: ${candidateMealPlanVersionId}`);
    this.name = 'CandidateDiffUnavailableError';
  }
}

export interface MealPlanRecalculationAnalysis {
  readonly fixedDays: readonly MealPlanDay[];
  readonly generationDates: readonly string[];
  readonly targetDiffs: readonly {
    readonly businessDate: string;
    readonly previousNutritionTargetVersionId: string;
    readonly proposedNutritionTargetVersionId: string;
    readonly reason: 'locked_or_manually_modified';
  }[];
}

export interface RecalculationResult {
  readonly recalculationJob: RecalculationJob;
  readonly candidateMealPlan: MealPlanVersion | null;
  readonly activatedMealPlan: MealPlanVersion | null;
  readonly targetDiffs: readonly MealPlanTargetDiff[];
}

export interface SavedTrainingPlanWithRecalculation extends SavedTrainingPlan, RecalculationResult {}

export interface RecordedTrainingCompletion
  extends Omit<RecalculationResult, 'recalculationJob'> {
  readonly event: TrainingCompletionEvent;
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
  readonly recalculationJob: RecalculationJob | null;
  readonly recalculationStatus:
    | 'not_required'
    | 'completed'
    | 'pending_confirmation'
    | 'failed_retryable';
}

export interface MealPlanCandidateDecisionResult {
  readonly decision: MealPlanDecision;
  readonly recalculationJob: RecalculationJob;
  readonly activatedMealPlan: MealPlanVersion | null;
}

interface RecalculationCompareToken {
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly inventoryVersionId: string;
  readonly activeMealPlanVersionId: string;
  readonly dailyNutritionTargetVersionIds: readonly string[];
  readonly providerSnapshotToken: string;
}

interface RecalculationPrerequisites {
  readonly previousMealPlan: MealPlanVersion;
  readonly targets: readonly DailyNutritionTargetVersion[];
  readonly compareToken: RecalculationCompareToken;
  readonly bodyProfile: ReturnType<typeof generationPrerequisites>['bodyProfile'];
  readonly goal: ReturnType<typeof generationPrerequisites>['goal'];
  readonly trainingPlan: ReturnType<typeof generationPrerequisites>['trainingPlan'];
  readonly inventory: ReturnType<typeof generationPrerequisites>['inventory'];
}

interface RecordedFact {
  readonly event: TrainingCompletionEvent;
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
  readonly dailyNutritionTargets: readonly DailyNutritionTargetVersion[];
  readonly recalculationJob: RecalculationJob | null;
}

interface RetryCommitContext {
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

function findById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string | null
): T | null {
  if (id === null) return null;
  return values.find((value) => value.id === id) ?? null;
}

function findJobByTrigger(
  state: PlanningAggregateState,
  triggerEventId: string
): RecalculationJob | null {
  return state.recalculationJobs.find((job) => job.triggerEventId === triggerEventId) ?? null;
}

function replaceJob(
  state: PlanningAggregateState,
  replacement: RecalculationJob
): readonly RecalculationJob[] {
  return state.recalculationJobs.map((job) => job.id === replacement.id ? replacement : job);
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

function findRecord<TOperation extends IdempotencyRecord['operation']>(
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

export function analyzeTrainingChangeAffectedDates(input: {
  readonly previousSessions: readonly TrainingSessionPayload[];
  readonly nextSessions: readonly TrainingSessionPayload[];
  readonly weekDates: readonly string[];
  readonly businessToday: string;
}): string[] {
  return affectedTrainingDates(
    input.previousSessions,
    input.nextSessions,
    input.weekDates.filter((date) => date >= input.businessToday)
  );
}

export function analyzeMealPlanRecalculation(input: {
  readonly previousDays: readonly MealPlanDay[];
  readonly affectedDates: readonly string[];
  readonly proposedTargetVersionIdsByDate: ReadonlyMap<string, string>;
}): MealPlanRecalculationAnalysis {
  const affected = new Set(input.affectedDates);
  const fixedDays: MealPlanDay[] = [];
  const generationDates: string[] = [];
  const targetDiffs: MealPlanRecalculationAnalysis['targetDiffs'][number][] = [];
  for (const day of input.previousDays) {
    if (!affected.has(day.businessDate)) {
      fixedDays.push(day);
      continue;
    }
    const proposedTargetVersionId = input.proposedTargetVersionIdsByDate.get(day.businessDate);
    if (proposedTargetVersionId === undefined) {
      throw new PlanningPrerequisiteError('daily_nutrition_targets');
    }
    if (!day.locked && !day.manuallyModified) {
      generationDates.push(day.businessDate);
      continue;
    }
    fixedDays.push({
      ...day,
      dailyNutritionTargetVersionId: proposedTargetVersionId
    });
    targetDiffs.push({
      businessDate: day.businessDate,
      previousNutritionTargetVersionId: day.dailyNutritionTargetVersionId,
      proposedNutritionTargetVersionId: proposedTargetVersionId,
      reason: 'locked_or_manually_modified'
    });
  }
  return {
    fixedDays,
    generationDates: generationDates.sort(),
    targetDiffs: targetDiffs.sort((left, right) => left.businessDate.localeCompare(right.businessDate))
  };
}

function targetDisplaySnapshot(
  state: PlanningAggregateState,
  targetVersionId: string
): MealPlanTargetDiff['previousTarget'] {
  const target = state.dailyNutritionTargets.find((candidate) => candidate.id === targetVersionId);
  if (target?.nutrition === null || target?.nutrition.kind !== 'feasible') {
    throw new PlanningPrerequisiteError('daily_nutrition_targets');
  }
  return {
    estimatedEnergyKcal: target.nutrition.targetEnergyKcal,
    proteinG: target.nutrition.proteinG,
    fatG: target.nutrition.fatG,
    carbohydrateG: target.nutrition.carbohydrateG,
    fiberRangeG: { ...target.nutrition.fiberRangeG }
  };
}

function mealDisplaySnapshots(day: MealPlanDay): MealPlanTargetDiff['previousMeals'] {
  return day.meals.map((meal) => ({
    slot: meal.slot,
    dishNameZh: meal.dishNameZh ?? '菜品名称暂不可用',
    ingredients: (meal.ingredients ?? []).map((ingredient) => ({ ...ingredient }))
  }));
}

function prerequisitesForJob(
  state: PlanningAggregateState,
  job: RecalculationJob,
  activeProviderSnapshotToken: string
): RecalculationPrerequisites {
  const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
  if (trainingPlan === null) throw new PlanningPrerequisiteError('training_plan');
  if (!recalculationJobHasCurrentProcessPrerequisites(state, job)) {
    throw new CandidateNotPendingError(job.id);
  }
  const prerequisites = generationPrerequisites(state, trainingPlan.payload.weekStartDate);
  const previousMealPlan = findById(state.mealPlans, state.activeMealPlanVersionId);
  if (previousMealPlan === null || previousMealPlan.readiness !== 'complete') {
    throw new PlanningPrerequisiteError('daily_nutrition_targets');
  }
  return {
    ...prerequisites,
    previousMealPlan,
    compareToken: {
      bodyProfileVersionId: prerequisites.bodyProfile.id,
      goalVersionId: prerequisites.goal.id,
      trainingPlanVersionId: prerequisites.trainingPlan.id,
      inventoryVersionId: prerequisites.inventory.id,
      activeMealPlanVersionId: previousMealPlan.id,
      dailyNutritionTargetVersionIds: prerequisites.targets.map((target) => target.id),
      providerSnapshotToken: activeProviderSnapshotToken
    }
  };
}

function compareTokensEqual(
  left: RecalculationCompareToken,
  right: RecalculationCompareToken
): boolean {
  return left.bodyProfileVersionId === right.bodyProfileVersionId
    && left.goalVersionId === right.goalVersionId
    && left.trainingPlanVersionId === right.trainingPlanVersionId
    && left.inventoryVersionId === right.inventoryVersionId
    && left.activeMealPlanVersionId === right.activeMealPlanVersionId
    && left.providerSnapshotToken === right.providerSnapshotToken
    && left.dailyNutritionTargetVersionIds.length === right.dailyNutritionTargetVersionIds.length
    && left.dailyNutritionTargetVersionIds.every(
      (id, index) => id === right.dailyNutritionTargetVersionIds[index]
    );
}

function resultForJob(state: PlanningAggregateState, job: RecalculationJob): RecalculationResult {
  const candidateMealPlan = findById(state.mealPlans, job.candidateMealPlanVersionId);
  const activatedMealPlan = findById(state.mealPlans, job.activatedMealPlanVersionId);
  return {
    recalculationJob: job,
    candidateMealPlan,
    activatedMealPlan,
    targetDiffs: candidateMealPlan === null
      ? []
      : state.mealPlanTargetDiffs.filter(
          (diff) => diff.candidateMealPlanVersionId === candidateMealPlan.id
        )
  };
}

function hasReplayableJobResult(job: RecalculationJob): boolean {
  return job.status === 'completed'
    || (job.status === 'pending' && job.candidateMealPlanVersionId !== null);
}

function statusForResult(result: RecalculationResult): RecordedTrainingCompletion['recalculationStatus'] {
  if (result.recalculationJob.status === 'failed_retryable') return 'failed_retryable';
  if (result.candidateMealPlan !== null) return 'pending_confirmation';
  return 'completed';
}

function withRetryIdempotencyRecord(
  state: PlanningAggregateState,
  jobId: string,
  context: RetryCommitContext | undefined
): PlanningAggregateState {
  if (context === undefined) return state;
  const existing = findRecord(state, 'retryPendingRecalculation', context.idempotencyKey);
  if (existing !== undefined) {
    assertReplay(existing, context.requestFingerprint, context.idempotencyKey);
    return state;
  }
  const record: IdempotencyRecord = {
    operation: 'retryPendingRecalculation',
    key: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    resultVersionId: jobId
  };
  return { ...state, idempotencyRecords: [...state.idempotencyRecords, record] };
}

export function createMealPlanRecalculationService(
  dependencies: MealPlanRecalculationServiceDependencies
) {
  const { repository, now, nextId } = dependencies;
  const base = createMealPlanEditingService(dependencies);

  async function markJobRetryable(
    userId: string,
    jobId: string,
    failureCode: NonNullable<RecalculationJob['failureCode']>,
    failureConflicts: RecalculationJob['failureConflicts'] = []
  ): Promise<RecalculationResult> {
    return repository.transact(userId, (state) => {
      const job = findById(state.recalculationJobs, jobId);
      if (job === null) throw new PlanningPrerequisiteError('daily_nutrition_targets');
      if (job.status === 'completed') {
        return { nextState: state, result: resultForJob(state, job) };
      }
      const failed: RecalculationJob = {
        ...job,
        status: 'failed_retryable',
        completedAt: null,
        activatedMealPlanVersionId: null,
        failureCode,
        failureConflictDetailsStatus: 'complete',
        failureConflicts: failureCode === 'nutrition_constraints_infeasible'
          ? [...failureConflicts]
          : []
      };
      const nextState = { ...state, recalculationJobs: replaceJob(state, failed) };
      return { nextState, result: resultForJob(nextState, failed) };
    });
  }

  async function completeEmptyJob(
    userId: string,
    jobId: string,
    retryCommit?: RetryCommitContext
  ): Promise<RecalculationResult> {
    return repository.transact(userId, (state) => {
      const job = findById(state.recalculationJobs, jobId);
      if (job === null) throw new PlanningPrerequisiteError('daily_nutrition_targets');
      if (job.status === 'completed') {
        const replayState = withRetryIdempotencyRecord(state, job.id, retryCommit);
        return { nextState: replayState, result: resultForJob(replayState, job) };
      }
      const completed: RecalculationJob = {
        ...job,
        status: 'completed',
        completedAt: now(),
        failureCode: null,
        failureConflictDetailsStatus: 'complete',
        failureConflicts: []
      };
      const nextState = withRetryIdempotencyRecord(
        { ...state, recalculationJobs: replaceJob(state, completed) },
        completed.id,
        retryCommit
      );
      return { nextState, result: resultForJob(nextState, completed) };
    });
  }

  async function commitExistingJobResult(
    userId: string,
    jobId: string,
    retryCommit: RetryCommitContext
  ): Promise<RecalculationResult> {
    return repository.transact(userId, (state) => {
      const job = findById(state.recalculationJobs, jobId);
      if (job === null || !hasReplayableJobResult(job)) {
        throw new CandidateNotPendingError(jobId);
      }
      const nextState = withRetryIdempotencyRecord(state, job.id, retryCommit);
      return { nextState, result: resultForJob(nextState, job) };
    });
  }

  async function processRecalculationJob(
    userId: string,
    jobId: string,
    retryCommit?: RetryCommitContext
  ): Promise<RecalculationResult> {
    const initialState = await repository.read(userId);
    const initialJob = findById(initialState.recalculationJobs, jobId);
    if (initialJob === null) throw new PlanningPrerequisiteError('daily_nutrition_targets');
    if (hasReplayableJobResult(initialJob)) {
      return retryCommit === undefined
        ? resultForJob(initialState, initialJob)
        : commitExistingJobResult(userId, initialJob.id, retryCommit);
    }
    if (initialJob.candidateMealPlanVersionId !== null) {
      if (retryCommit !== undefined) throw new CandidateNotPendingError(initialJob.id);
      return resultForJob(initialState, initialJob);
    }
    if (initialJob.affectedDates.length === 0 || initialState.activeMealPlanVersionId === null) {
      return completeEmptyJob(userId, initialJob.id, retryCommit);
    }
    if (!recalculationJobHasCurrentProcessPrerequisites(initialState, initialJob)) {
      throw new CandidateNotPendingError(initialJob.id);
    }

    const providerSnapshot = await loadProviderSnapshot(dependencies.providers);
    const initial = prerequisitesForJob(
      initialState,
      initialJob,
      providerSnapshotToken(providerSnapshot)
    );
    const targetsByDate = new Map(initial.targets.map((target) => [target.businessDate, target.id]));
    const analysis = analyzeMealPlanRecalculation({
      previousDays: initial.previousMealPlan.weekStartDate === initial.trainingPlan.payload.weekStartDate
        ? initial.previousMealPlan.days
        : [],
      affectedDates: initialJob.affectedDates,
      proposedTargetVersionIdsByDate: targetsByDate
    });
    const generated = generateWeeklyMealPlan({
      weekStartDate: initial.trainingPlan.payload.weekStartDate,
      targets: initial.targets,
      inventory: initial.inventory.items,
      allergens: initial.bodyProfile.payload.allergens,
      avoidFoodIds: initial.bodyProfile.payload.avoidFoods,
      catalog: providerSnapshot.catalog,
      menus: providerSnapshot.menus,
      recipes: providerSnapshot.recipes,
      snapshots: providerSnapshot.snapshots,
      allowTestFixtures: dependencies.providers.allowTestFixtures,
      fixedDays: analysis.fixedDays
    });
    if (generated.kind === 'infeasible') {
      throw new NutritionConstraintsInfeasibleError(
        withReviewedFoodNames(generated.conflicts, providerSnapshot.snapshots)
      );
    }
    const commitProviderSnapshot = await loadProviderSnapshot(dependencies.providers);
    const commitProviderSnapshotToken = providerSnapshotToken(commitProviderSnapshot);
    if (commitProviderSnapshotToken !== initial.compareToken.providerSnapshotToken) {
      throw new VersionConflictError(initialState.mealPlans.length, initialState.mealPlans.length);
    }

    return repository.transact(userId, (state) => {
      const job = findById(state.recalculationJobs, jobId);
      if (job === null) throw new PlanningPrerequisiteError('daily_nutrition_targets');
      if (hasReplayableJobResult(job)) {
        const replayState = withRetryIdempotencyRecord(state, job.id, retryCommit);
        return { nextState: replayState, result: resultForJob(replayState, job) };
      }
      if (job.candidateMealPlanVersionId !== null) {
        if (retryCommit !== undefined) throw new CandidateNotPendingError(job.id);
        return { nextState: state, result: resultForJob(state, job) };
      }
      const current = prerequisitesForJob(state, job, commitProviderSnapshotToken);
      if (!compareTokensEqual(initial.compareToken, current.compareToken)) {
        throw new VersionConflictError(state.mealPlans.length, state.mealPlans.length);
      }
      const createdAt = now();
      const candidateId = nextId('meal-plan');
      const pendingConfirmation = analysis.targetDiffs.length > 0;
      const mealPlan: MealPlanVersion = {
        kind: 'meal_plan_version',
        id: candidateId,
        userId,
        version: state.mealPlans.length + 1,
        createdAt,
        weekStartDate: current.trainingPlan.payload.weekStartDate,
        bodyProfileVersionId: current.bodyProfile.id,
        goalVersionId: current.goal.id,
        trainingPlanVersionId: current.trainingPlan.id,
        inventoryVersionId: current.inventory.id,
        catalogVersionId: generated.catalogVersionId,
        generationPolicyVersion: generated.policyVersion,
        supersedesVersionId: current.previousMealPlan.id,
        readiness: pendingConfirmation ? 'pending_confirmation' : 'complete',
        days: generated.days
      };
      const diffs: MealPlanTargetDiff[] = analysis.targetDiffs.map((diff) => {
        const previousDay = current.previousMealPlan.days.find(
          (day) => day.businessDate === diff.businessDate
        );
        const proposedDay = generated.days.find(
          (day) => day.businessDate === diff.businessDate
        );
        if (previousDay === undefined || proposedDay === undefined) {
          throw new PlanningPrerequisiteError('daily_nutrition_targets');
        }
        return {
          id: nextId('meal-plan-target-diff'),
          userId,
          candidateMealPlanVersionId: mealPlan.id,
          ...diff,
          previousTarget: targetDisplaySnapshot(state, diff.previousNutritionTargetVersionId),
          proposedTarget: targetDisplaySnapshot(state, diff.proposedNutritionTargetVersionId),
          previousMeals: mealDisplaySnapshots(previousDay),
          proposedMeals: mealDisplaySnapshots(proposedDay)
        };
      });
      const completedJob: RecalculationJob = {
        ...job,
        status: pendingConfirmation ? 'pending' : 'completed',
        completedAt: pendingConfirmation ? null : createdAt,
        candidateMealPlanVersionId: pendingConfirmation ? mealPlan.id : null,
        activatedMealPlanVersionId: pendingConfirmation ? null : mealPlan.id,
        failureCode: null,
        failureConflictDetailsStatus: 'complete',
        failureConflicts: []
      };
      const nextState = withRetryIdempotencyRecord({
        ...state,
        mealPlans: [...state.mealPlans, mealPlan],
        mealPlanTargetDiffs: [...state.mealPlanTargetDiffs, ...diffs],
        recalculationJobs: replaceJob(state, completedJob),
        activeMealPlanVersionId: pendingConfirmation
          ? state.activeMealPlanVersionId
          : mealPlan.id
      }, completedJob.id, retryCommit);
      return { nextState, result: resultForJob(nextState, completedJob) };
    });
  }

  async function processImmediate(
    userId: string,
    job: RecalculationJob
  ): Promise<RecalculationResult> {
    try {
      return await processRecalculationJob(userId, job.id);
    } catch (error: unknown) {
      if (error instanceof ProviderUnavailableError) {
        return markJobRetryable(userId, job.id, 'provider_unavailable');
      }
      if (error instanceof NutritionConstraintsInfeasibleError) {
        return markJobRetryable(
          userId,
          job.id,
          'nutrition_constraints_infeasible',
          error.conflicts
        );
      }
      throw error;
    }
  }

  function replayRecordedFact(state: PlanningAggregateState, eventId: string): RecordedFact {
    const event = findById(state.trainingCompletionEvents, eventId);
    if (event === null) throw new Error('Stored idempotency result is missing');
    return {
      event,
      dailyEnergyTargets: state.dailyEnergyTargets.filter(
        (target) => target.trainingCompletionEventId === event.id
      ),
      dailyNutritionTargets: state.dailyNutritionTargets.filter(
        (target) => target.trainingCompletionEventId === event.id
      ),
      recalculationJob: findJobByTrigger(state, event.id)
    };
  }

  async function appendCompletionFact(
    userId: string,
    envelope: WriteCommandEnvelope<{
      readonly businessDate: string;
      readonly completedDurationMinutes: number;
    }>
  ): Promise<RecordedFact> {
    const expectedFingerprint = requestFingerprint({
      expectedVersion: envelope.expectedVersion,
      payload: envelope.payload
    });
    return repository.transact(userId, (state) => {
      const replay = findRecord(state, 'recordTrainingCompletion', envelope.idempotencyKey);
      if (replay !== undefined) {
        assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
        return { nextState: state, result: replayRecordedFact(state, replay.resultVersionId) };
      }
      if (envelope.expectedVersion !== state.trainingCompletionEvents.length) {
        throw new VersionConflictError(
          envelope.expectedVersion,
          state.trainingCompletionEvents.length
        );
      }
      const profile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
      const goal = findById(state.goals, state.activeGoalVersionId);
      const trainingPlan = findById(state.trainingPlans, state.activeTrainingPlanVersionId);
      if (profile === null) throw new PlanningPrerequisiteError('body_profile');
      if (goal === null || goal.bodyProfileVersionId !== profile.id) {
        throw new PlanningPrerequisiteError('goal');
      }
      if (
        trainingPlan === null
        || trainingPlan.bodyProfileVersionId !== profile.id
        || trainingPlan.goalVersionId !== goal.id
      ) throw new PlanningPrerequisiteError('training_plan');
      const plannedSession = trainingPlan.payload.sessions.find(
        (session) => session.businessDate === envelope.payload.businessDate
      );
      if (plannedSession === undefined) {
        throw new InvalidTrainingPlanError('completion_not_planned');
      }
      const occurredAt = now();
      const businessToday = businessDateAt(occurredAt, profile.payload.businessTimezone);
      if (envelope.payload.businessDate > businessToday) {
        throw new FutureCompletionForbiddenError(envelope.payload.businessDate);
      }
      const event: TrainingCompletionEvent = {
        kind: 'training_completion_event',
        id: nextId('training-completion'),
        userId,
        version: state.trainingCompletionEvents.length + 1,
        trainingPlanVersionId: trainingPlan.id,
        businessDate: envelope.payload.businessDate,
        completedDurationMinutes: envelope.payload.completedDurationMinutes,
        occurredAt
      };
      let dailyEnergyTargets: DailyEnergyTargetVersion[] = [];
      let dailyNutritionTargets: DailyNutritionTargetVersion[] = [];
      let recalculationJob: RecalculationJob | null = null;
      if (envelope.payload.businessDate === businessToday) {
        const hasCompletedTraining = envelope.payload.completedDurationMinutes > 0;
        const energy = previewDailyEnergy({
          ageYears: profile.payload.ageYears,
          sexCode: profile.payload.sexCode,
          heightCm: profile.payload.heightCm,
          weightKg: profile.payload.weightKg,
          healthScopeConfirmed: profile.payload.healthScopeConfirmed,
          nonTrainingActivity: profile.payload.nonTrainingActivity,
          goal: goal.payload.goal,
          ...(hasCompletedTraining
            ? {
                training: {
                  sessionCode: plannedSession.sessionCode,
                  durationMinutes: envelope.payload.completedDurationMinutes
                }
              }
            : {})
        });
        const energyTarget: DailyEnergyTargetVersion = {
          kind: 'daily_energy_target_version',
          id: nextId('daily-energy-target'),
          userId,
          version: state.dailyEnergyTargets.filter(
            (target) => target.businessDate === event.businessDate
          ).length + 1,
          createdAt: occurredAt,
          businessDate: event.businessDate,
          bodyProfileVersionId: profile.id,
          goalVersionId: goal.id,
          trainingPlanVersionId: trainingPlan.id,
          energyPolicyVersion: 'calculation-policy-v2',
          nutritionPolicyVersion: 'nutrition-policy-v1',
          trainingCompletionEventId: event.id,
          energy
        };
        const reviewedSession = hasCompletedTraining
          ? findReviewedTrainingSession(plannedSession.sessionCode)
          : undefined;
        const nutrition = energy.kind === 'supported'
          ? calculateNutritionTargets({
              targetEnergyKcal: energy.targetEnergyKcal,
              weightKg: profile.payload.weightKg,
              sexCode: profile.payload.sexCode,
              goal: goal.payload.goal,
              trainingKind: reviewedSession?.trainingKind ?? 'none'
            })
          : null;
        const nutritionTarget: DailyNutritionTargetVersion = {
          kind: 'daily_nutrition_target_version',
          id: nextId('daily-nutrition-target'),
          userId,
          version: state.dailyNutritionTargets.filter(
            (target) => target.businessDate === event.businessDate
          ).length + 1,
          createdAt: occurredAt,
          businessDate: event.businessDate,
          bodyProfileVersionId: profile.id,
          goalVersionId: goal.id,
          trainingPlanVersionId: trainingPlan.id,
          dailyEnergyTargetVersionId: energyTarget.id,
          energyPolicyVersion: 'calculation-policy-v2',
          nutritionPolicyVersion: 'nutrition-policy-v1',
          trainingCompletionEventId: event.id,
          energy,
          nutrition
        };
        dailyEnergyTargets = [energyTarget];
        dailyNutritionTargets = [nutritionTarget];
        recalculationJob = {
          kind: 'recalculation_job',
          id: nextId('recalculation-job'),
          userId,
          triggerEventId: event.id,
          triggerType: 'training_completion',
          affectedDates: [event.businessDate],
          status: 'pending',
          createdAt: occurredAt,
          completedAt: null,
          candidateMealPlanVersionId: null,
          activatedMealPlanVersionId: null,
          failureCode: null,
          failureConflictDetailsStatus: 'complete',
          failureConflicts: []
        };
      }
      const record: IdempotencyRecord = {
        operation: 'recordTrainingCompletion',
        key: envelope.idempotencyKey,
        requestFingerprint: expectedFingerprint,
        resultVersionId: event.id
      };
      const nextState: PlanningAggregateState = {
        ...state,
        trainingCompletionEvents: [...state.trainingCompletionEvents, event],
        dailyEnergyTargets: [...state.dailyEnergyTargets, ...dailyEnergyTargets],
        dailyNutritionTargets: [...state.dailyNutritionTargets, ...dailyNutritionTargets],
        recalculationJobs: recalculationJob === null
          ? state.recalculationJobs
          : [...state.recalculationJobs, recalculationJob],
        idempotencyRecords: [...state.idempotencyRecords, record]
      };
      return {
        nextState,
        result: { event, dailyEnergyTargets, dailyNutritionTargets, recalculationJob }
      };
    });
  }

  async function ensureEventJob(
    userId: string,
    eventId: string
  ): Promise<RecalculationJob> {
    return repository.transact(userId, (state) => {
      const existing = findJobByTrigger(state, eventId);
      if (existing !== null) return { nextState: state, result: existing };
      const event = state.outboxEvents.find((candidate) => candidate.eventId === eventId);
      if (event === undefined) throw new PlanningPrerequisiteError('training_plan');
      const job: RecalculationJob = {
        kind: 'recalculation_job',
        id: nextId('recalculation-job'),
        userId,
        triggerEventId: event.eventId,
        triggerType: 'training_plan_changed',
        affectedDates: event.affectedDates,
        status: 'pending',
        createdAt: event.occurredAt,
        completedAt: null,
        candidateMealPlanVersionId: null,
        activatedMealPlanVersionId: null,
        failureCode: null,
        failureConflictDetailsStatus: 'complete',
        failureConflicts: []
      };
      return {
        nextState: { ...state, recalculationJobs: [...state.recalculationJobs, job] },
        result: job
      };
    });
  }

  return {
    ...base,

    async saveTrainingPlan(
      userId: string,
      envelope: Parameters<typeof base.saveTrainingPlan>[1]
    ): Promise<SavedTrainingPlanWithRecalculation> {
      const saved = await base.saveTrainingPlan(userId, envelope);
      const state = await repository.read(userId);
      const event = state.outboxEvents.find(
        (candidate) => candidate.trainingPlanVersionId === saved.trainingPlan.id
      );
      if (event === undefined) throw new Error('Stored training event is missing');
      const job = await ensureEventJob(userId, event.eventId);
      const processed = await processImmediate(userId, job);
      return { ...saved, ...processed };
    },

    async processTrainingPlanChanged(
      userId: string,
      eventId: string
    ): Promise<RecalculationResult> {
      const job = await ensureEventJob(userId, eventId);
      return processImmediate(userId, job);
    },

    async recordTrainingCompletion(
      userId: string,
      envelope: WriteCommandEnvelope<{
        readonly businessDate: string;
        readonly completedDurationMinutes: number;
      }>
    ): Promise<RecordedTrainingCompletion> {
      const recorded = await appendCompletionFact(userId, envelope);
      if (recorded.recalculationJob === null) {
        return {
          ...recorded,
          candidateMealPlan: null,
          activatedMealPlan: null,
          targetDiffs: [],
          recalculationStatus: 'not_required'
        };
      }
      const currentState = await repository.read(userId);
      const currentJob = findJobByTrigger(currentState, recorded.event.id);
      if (currentJob === null) throw new Error('Stored recalculation job is missing');
      const processed = currentJob.status === 'pending'
        ? await processImmediate(userId, currentJob)
        : resultForJob(currentState, currentJob);
      return {
        event: recorded.event,
        dailyEnergyTargets: recorded.dailyEnergyTargets,
        dailyNutritionTargets: recorded.dailyNutritionTargets,
        ...processed,
        recalculationStatus: statusForResult(processed)
      };
    },

    async decideMealPlanCandidate(
      userId: string,
      envelope: WriteCommandEnvelope<{
        readonly candidateMealPlanVersionId: string;
        readonly decision: 'keep_existing' | 'overwrite_locked';
      }>
    ): Promise<MealPlanCandidateDecisionResult> {
      const expectedFingerprint = requestFingerprint({
        expectedVersion: envelope.expectedVersion,
        payload: envelope.payload
      });
      const initialState = await repository.read(userId);
      const replay = findRecord(
        initialState,
        'decideMealPlanCandidate',
        envelope.idempotencyKey
      );
      if (replay !== undefined) {
        assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
        const decision = findById(initialState.mealPlanDecisions, replay.resultVersionId);
        if (decision === null) throw new Error('Stored idempotency result is missing');
        const job = initialState.recalculationJobs.find(
          (candidate) => candidate.candidateMealPlanVersionId === decision.candidateMealPlanVersionId
        );
        if (job === undefined) throw new Error('Stored recalculation job is missing');
        return {
          decision,
          recalculationJob: job,
          activatedMealPlan: findById(
            initialState.mealPlans,
            decision.activatedMealPlanVersionId
          )
        };
      }
      if (envelope.expectedVersion !== initialState.mealPlanDecisions.length) {
        throw new VersionConflictError(
          envelope.expectedVersion,
          initialState.mealPlanDecisions.length
        );
      }
      const candidate = findById(
        initialState.mealPlans,
        envelope.payload.candidateMealPlanVersionId
      );
      const job = initialState.recalculationJobs.find(
        (value) => value.candidateMealPlanVersionId === envelope.payload.candidateMealPlanVersionId
      );
      const previous = candidate === null
        ? null
        : findById(initialState.mealPlans, candidate.supersedesVersionId);
      if (
        candidate === null
        || job === undefined
        || previous === null
        || !pendingMealPlanCandidateMatchesCurrentContext(initialState, candidate)
        || initialState.mealPlanDecisions.some(
          (decision) => decision.candidateMealPlanVersionId === candidate.id
        )
      ) throw new CandidateNotPendingError(envelope.payload.candidateMealPlanVersionId);

      if (envelope.payload.decision === 'keep_existing') {
        return repository.transact(userId, (state) => {
          const concurrentReplay = findRecord(
            state,
            'decideMealPlanCandidate',
            envelope.idempotencyKey
          );
          if (concurrentReplay !== undefined) {
            assertReplay(concurrentReplay, expectedFingerprint, envelope.idempotencyKey);
            const stored = findById(state.mealPlanDecisions, concurrentReplay.resultVersionId);
            if (stored === null) throw new Error('Stored idempotency result is missing');
            const storedJob = state.recalculationJobs.find(
              (value) => value.candidateMealPlanVersionId === stored.candidateMealPlanVersionId
            );
            if (storedJob === undefined) throw new Error('Stored recalculation job is missing');
            return {
              nextState: state,
              result: { decision: stored, recalculationJob: storedJob, activatedMealPlan: null }
            };
          }
          if (
            state.mealPlanDecisions.length !== envelope.expectedVersion
            || !pendingMealPlanCandidateMatchesCurrentContext(state, candidate)
            || state.mealPlanDecisions.some(
              (decision) => decision.candidateMealPlanVersionId === candidate.id
            )
          ) throw new CandidateNotPendingError(candidate.id);
          const currentJob = findById(state.recalculationJobs, job.id);
          if (currentJob === null || currentJob.status === 'completed') {
            throw new CandidateNotPendingError(candidate.id);
          }
          const decidedAt = now();
          const decision: MealPlanDecision = {
            kind: 'meal_plan_decision',
            id: nextId('meal-plan-decision'),
            userId,
            version: state.mealPlanDecisions.length + 1,
            candidateMealPlanVersionId: candidate.id,
            previousActiveMealPlanVersionId: previous.id,
            decision: 'keep_existing',
            decidedAt,
            activatedMealPlanVersionId: null
          };
          const completedJob: RecalculationJob = {
            ...currentJob,
            status: 'completed',
            completedAt: decidedAt,
            activatedMealPlanVersionId: null,
            failureCode: null,
            failureConflictDetailsStatus: 'complete',
            failureConflicts: []
          };
          const record: IdempotencyRecord = {
            operation: 'decideMealPlanCandidate',
            key: envelope.idempotencyKey,
            requestFingerprint: expectedFingerprint,
            resultVersionId: decision.id
          };
          return {
            nextState: {
              ...state,
              mealPlanDecisions: [...state.mealPlanDecisions, decision],
              recalculationJobs: replaceJob(state, completedJob),
              idempotencyRecords: [...state.idempotencyRecords, record]
            },
            result: { decision, recalculationJob: completedJob, activatedMealPlan: null }
          };
        });
      }

      const candidateDiffs = initialState.mealPlanTargetDiffs.filter(
        (diff) => diff.candidateMealPlanVersionId === candidate.id
      );
      if (
        candidateDiffs.length === 0
        || candidateDiffs.some((diff) => (
          diff.previousTarget === undefined
          || diff.proposedTarget === undefined
          || diff.previousMeals === undefined
          || diff.proposedMeals === undefined
        ))
      ) throw new CandidateDiffUnavailableError(candidate.id);

      let providerSnapshot: Awaited<ReturnType<typeof loadProviderSnapshot>>;
      try {
        providerSnapshot = await loadProviderSnapshot(dependencies.providers);
      } catch (error: unknown) {
        if (error instanceof ProviderUnavailableError) {
          await markJobRetryable(userId, job.id, 'provider_unavailable');
        }
        throw error;
      }
      const initial = prerequisitesForJob(
        initialState,
        job,
        providerSnapshotToken(providerSnapshot)
      );
      const affected = new Set(job.affectedDates);
      const generated = generateWeeklyMealPlan({
        weekStartDate: initial.trainingPlan.payload.weekStartDate,
        targets: initial.targets,
        inventory: initial.inventory.items,
        allergens: initial.bodyProfile.payload.allergens,
        avoidFoodIds: initial.bodyProfile.payload.avoidFoods,
        catalog: providerSnapshot.catalog,
        menus: providerSnapshot.menus,
        recipes: providerSnapshot.recipes,
        snapshots: providerSnapshot.snapshots,
        allowTestFixtures: dependencies.providers.allowTestFixtures,
        fixedDays: candidate.days.filter((day) => !affected.has(day.businessDate))
      });
      if (generated.kind === 'infeasible') {
        const failure = new NutritionConstraintsInfeasibleError(
          withReviewedFoodNames(generated.conflicts, providerSnapshot.snapshots)
        );
        await markJobRetryable(
          userId,
          job.id,
          'nutrition_constraints_infeasible',
          failure.conflicts
        );
        throw failure;
      }
      let commitProviderSnapshotToken: string;
      try {
        commitProviderSnapshotToken = providerSnapshotToken(
          await loadProviderSnapshot(dependencies.providers)
        );
      } catch (error: unknown) {
        if (error instanceof ProviderUnavailableError) {
          await markJobRetryable(userId, job.id, 'provider_unavailable');
        }
        throw error;
      }
      if (commitProviderSnapshotToken !== initial.compareToken.providerSnapshotToken) {
        throw new VersionConflictError(initialState.mealPlans.length, initialState.mealPlans.length);
      }
      try {
        return await repository.transact(userId, (state) => {
          if (state.mealPlanDecisions.length !== envelope.expectedVersion) {
            throw new VersionConflictError(
              envelope.expectedVersion,
              state.mealPlanDecisions.length
            );
          }
          const currentJob = findById(state.recalculationJobs, job.id);
          const currentCandidate = findById(state.mealPlans, candidate.id);
          if (
            currentJob === null
            || currentCandidate === null
            || !pendingMealPlanCandidateMatchesCurrentContext(state, currentCandidate)
          ) throw new CandidateNotPendingError(candidate.id);
          const current = prerequisitesForJob(state, currentJob, commitProviderSnapshotToken);
          if (!compareTokensEqual(initial.compareToken, current.compareToken)) {
            throw new VersionConflictError(state.mealPlans.length, state.mealPlans.length);
          }
          const decidedAt = now();
          const activated: MealPlanVersion = {
            kind: 'meal_plan_version',
            id: nextId('meal-plan'),
            userId,
            version: state.mealPlans.length + 1,
            createdAt: decidedAt,
            weekStartDate: current.trainingPlan.payload.weekStartDate,
            bodyProfileVersionId: current.bodyProfile.id,
            goalVersionId: current.goal.id,
            trainingPlanVersionId: current.trainingPlan.id,
            inventoryVersionId: current.inventory.id,
            catalogVersionId: generated.catalogVersionId,
            generationPolicyVersion: generated.policyVersion,
            supersedesVersionId: currentCandidate.id,
            readiness: 'complete',
            days: generated.days
          };
          const decision: MealPlanDecision = {
            kind: 'meal_plan_decision',
            id: nextId('meal-plan-decision'),
            userId,
            version: state.mealPlanDecisions.length + 1,
            candidateMealPlanVersionId: currentCandidate.id,
            previousActiveMealPlanVersionId: previous.id,
            decision: 'overwrite_locked',
            decidedAt,
            activatedMealPlanVersionId: activated.id
          };
          const completedJob: RecalculationJob = {
            ...currentJob,
            status: 'completed',
            completedAt: decidedAt,
            activatedMealPlanVersionId: activated.id,
            failureCode: null,
            failureConflictDetailsStatus: 'complete',
            failureConflicts: []
          };
          const record: IdempotencyRecord = {
            operation: 'decideMealPlanCandidate',
            key: envelope.idempotencyKey,
            requestFingerprint: expectedFingerprint,
            resultVersionId: decision.id
          };
          return {
            nextState: {
              ...state,
              mealPlans: [...state.mealPlans, activated],
              mealPlanDecisions: [...state.mealPlanDecisions, decision],
              recalculationJobs: replaceJob(state, completedJob),
              activeMealPlanVersionId: activated.id,
              idempotencyRecords: [...state.idempotencyRecords, record]
            },
            result: { decision, recalculationJob: completedJob, activatedMealPlan: activated }
          };
        });
      } catch (error: unknown) {
        if (error instanceof ProviderUnavailableError) {
          await markJobRetryable(userId, job.id, 'provider_unavailable');
        }
        throw error;
      }
    },

    async retryPendingRecalculation(
      userId: string,
      envelope: WriteCommandEnvelope<{ readonly recalculationJobId: string }>
    ): Promise<RecalculationResult> {
      const expectedFingerprint = requestFingerprint({
        expectedVersion: envelope.expectedVersion,
        payload: envelope.payload
      });
      const initialState = await repository.read(userId);
      const replay = findRecord(
        initialState,
        'retryPendingRecalculation',
        envelope.idempotencyKey
      );
      if (replay !== undefined) {
        assertReplay(replay, expectedFingerprint, envelope.idempotencyKey);
        const job = findById(initialState.recalculationJobs, replay.resultVersionId);
        if (job === null) throw new Error('Stored idempotency result is missing');
        return resultForJob(initialState, job);
      }
      if (envelope.expectedVersion !== initialState.recalculationJobs.length) {
        throw new VersionConflictError(
          envelope.expectedVersion,
          initialState.recalculationJobs.length
        );
      }
      const job = findById(initialState.recalculationJobs, envelope.payload.recalculationJobId);
      const hasExistingResult = job !== null && hasReplayableJobResult(job);
      const canStartRetry = job !== null
        && recalculationJobCanRetryForCurrentContext(initialState, job);
      if (job === null || (!hasExistingResult && !canStartRetry)) {
        throw new CandidateNotPendingError(envelope.payload.recalculationJobId);
      }
      let processed: RecalculationResult;
      try {
        processed = await processRecalculationJob(userId, job.id, {
          idempotencyKey: envelope.idempotencyKey,
          requestFingerprint: expectedFingerprint
        });
      } catch (error: unknown) {
        if (error instanceof ProviderUnavailableError) {
          await markJobRetryable(userId, job.id, 'provider_unavailable');
        } else if (error instanceof NutritionConstraintsInfeasibleError) {
          await markJobRetryable(
            userId,
            job.id,
            'nutrition_constraints_infeasible',
            error.conflicts
          );
        }
        throw error;
      }
      return processed;
    }
  };
}
