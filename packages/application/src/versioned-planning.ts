import type {
  BodyProfilePayload,
  BodyProfileVersion,
  CurrentPlanningContext,
  DailyEnergyTargetVersion,
  GoalPayload,
  GoalVersion,
  IdempotencyRecord,
  PlanningAggregateState,
  TrainingPlanPayload,
  TrainingPlanVersion,
  WriteCommandEnvelope
} from '@fitness/domain';
import { requestFingerprint } from './idempotency-fingerprint';
import { previewDailyEnergy } from './preview-daily-energy';

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

  public constructor(public readonly prerequisite: 'body_profile' | 'goal') {
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
    public readonly reason: 'date_outside_week' | 'duplicate_training_date'
  ) {
    super(`Invalid training plan: ${reason}`);
    this.name = 'InvalidTrainingPlanError';
  }
}

export interface SavedTrainingPlan {
  readonly trainingPlan: TrainingPlanVersion;
  readonly dailyEnergyTargets: readonly DailyEnergyTargetVersion[];
}

function findById<T extends { readonly id: string }>(
  values: readonly T[],
  id: string | null
): T | null {
  if (id === null) return null;
  return values.find((value) => value.id === id) ?? null;
}

function fingerprint<T>(envelope: WriteCommandEnvelope<T>): string {
  return requestFingerprint({
    expectedVersion: envelope.expectedVersion,
    payload: envelope.payload
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
  requestFingerprint: string,
  idempotencyKey: string
): void {
  if (record.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyKeyReuseError(idempotencyKey);
  }
}

function assertExpectedVersion(expectedVersion: number, actualVersion: number): void {
  if (expectedVersion !== actualVersion) {
    throw new VersionConflictError(expectedVersion, actualVersion);
  }
}

function appendDays(startDate: string, count: number): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
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

export function createVersionedPlanningService(
  dependencies: VersionedPlanningServiceDependencies
) {
  const { repository, now, nextId } = dependencies;

  return {
    async saveBodyProfile(
      userId: string,
      envelope: WriteCommandEnvelope<BodyProfilePayload>
    ): Promise<BodyProfileVersion> {
      return repository.transact(userId, (state) => {
        const requestFingerprint = fingerprint(envelope);
        const replay = findIdempotencyRecord(
          state,
          'saveBodyProfile',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, requestFingerprint, envelope.idempotencyKey);
          const previous = state.bodyProfiles.find(
            (profile) => profile.id === replay.resultVersionId
          );
          if (previous === undefined) throw new Error('Stored idempotency result is missing');
          return { nextState: state, result: previous };
        }

        const actualVersion = state.bodyProfiles.length;
        assertExpectedVersion(envelope.expectedVersion, actualVersion);
        const version: BodyProfileVersion = {
          kind: 'body_profile_version',
          id: nextId('body-profile'),
          userId,
          version: actualVersion + 1,
          createdAt: now(),
          payload: envelope.payload
        };
        const record: IdempotencyRecord = {
          operation: 'saveBodyProfile',
          key: envelope.idempotencyKey,
          requestFingerprint,
          resultVersionId: version.id
        };
        return {
          nextState: {
            ...state,
            bodyProfiles: [...state.bodyProfiles, version],
            idempotencyRecords: [...state.idempotencyRecords, record],
            activeBodyProfileVersionId: version.id
          },
          result: version
        };
      });
    },

    async saveGoal(
      userId: string,
      envelope: WriteCommandEnvelope<GoalPayload>
    ): Promise<GoalVersion> {
      return repository.transact(userId, (state) => {
        const requestFingerprint = fingerprint(envelope);
        const replay = findIdempotencyRecord(state, 'saveGoal', envelope.idempotencyKey);
        if (replay !== undefined) {
          assertReplay(replay, requestFingerprint, envelope.idempotencyKey);
          const previous = state.goals.find((goal) => goal.id === replay.resultVersionId);
          if (previous === undefined) throw new Error('Stored idempotency result is missing');
          return { nextState: state, result: previous };
        }

        const profile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
        if (profile === null) throw new PlanningPrerequisiteError('body_profile');
        const actualVersion = state.goals.length;
        assertExpectedVersion(envelope.expectedVersion, actualVersion);

        if (
          envelope.payload.goal === 'fat_loss'
          && envelope.payload.targetWeightKg !== undefined
        ) {
          const heightM = profile.payload.heightCm / 100;
          const targetBmi = envelope.payload.targetWeightKg / (heightM * heightM);
          if (targetBmi < 18.5) {
            throw new InvalidGoalError('target_bmi_below_supported_floor');
          }
        }

        const version: GoalVersion = {
          kind: 'goal_version',
          id: nextId('goal'),
          userId,
          version: actualVersion + 1,
          createdAt: now(),
          bodyProfileVersionId: profile.id,
          payload: envelope.payload
        };
        const record: IdempotencyRecord = {
          operation: 'saveGoal',
          key: envelope.idempotencyKey,
          requestFingerprint,
          resultVersionId: version.id
        };
        return {
          nextState: {
            ...state,
            goals: [...state.goals, version],
            idempotencyRecords: [...state.idempotencyRecords, record],
            activeGoalVersionId: version.id
          },
          result: version
        };
      });
    },

    async saveTrainingPlan(
      userId: string,
      envelope: WriteCommandEnvelope<TrainingPlanPayload>
    ): Promise<SavedTrainingPlan> {
      return repository.transact(userId, (state) => {
        const requestFingerprint = fingerprint(envelope);
        const replay = findIdempotencyRecord(
          state,
          'saveTrainingPlan',
          envelope.idempotencyKey
        );
        if (replay !== undefined) {
          assertReplay(replay, requestFingerprint, envelope.idempotencyKey);
          const previous = state.trainingPlans.find(
            (plan) => plan.id === replay.resultVersionId
          );
          if (previous === undefined) throw new Error('Stored idempotency result is missing');
          return {
            nextState: state,
            result: {
              trainingPlan: previous,
              dailyEnergyTargets: state.dailyEnergyTargets.filter(
                (target) => target.trainingPlanVersionId === previous.id
              )
            }
          };
        }

        const profile = findById(state.bodyProfiles, state.activeBodyProfileVersionId);
        if (profile === null) throw new PlanningPrerequisiteError('body_profile');
        const goal = findById(state.goals, state.activeGoalVersionId);
        if (goal === null) throw new PlanningPrerequisiteError('goal');
        if (goal.bodyProfileVersionId !== profile.id) {
          throw new PlanningPrerequisiteError('goal');
        }
        const actualVersion = state.trainingPlans.length;
        assertExpectedVersion(envelope.expectedVersion, actualVersion);

        const weekDates = appendDays(envelope.payload.weekStartDate, 7);
        assertTrainingDates(envelope.payload, weekDates);
        const trainingPlan: TrainingPlanVersion = {
          kind: 'training_plan_version',
          id: nextId('training-plan'),
          userId,
          version: actualVersion + 1,
          createdAt: now(),
          bodyProfileVersionId: profile.id,
          goalVersionId: goal.id,
          payload: envelope.payload
        };
        const dailyEnergyTargets = weekDates.map((businessDate) => {
          const session = envelope.payload.sessions.find(
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
          const existingForDate = state.dailyEnergyTargets.filter(
            (target) => target.businessDate === businessDate
          ).length;
          const target: DailyEnergyTargetVersion = {
            kind: 'daily_energy_target_version',
            id: nextId('daily-energy-target'),
            userId,
            version: existingForDate + 1,
            createdAt: now(),
            businessDate,
            bodyProfileVersionId: profile.id,
            goalVersionId: goal.id,
            trainingPlanVersionId: trainingPlan.id,
            energyPolicyVersion: 'calculation-policy-v2',
            nutritionPolicyVersion: 'nutrition-policy-v1',
            energy
          };
          return target;
        });
        const record: IdempotencyRecord = {
          operation: 'saveTrainingPlan',
          key: envelope.idempotencyKey,
          requestFingerprint,
          resultVersionId: trainingPlan.id
        };
        return {
          nextState: {
            ...state,
            trainingPlans: [...state.trainingPlans, trainingPlan],
            dailyEnergyTargets: [...state.dailyEnergyTargets, ...dailyEnergyTargets],
            idempotencyRecords: [...state.idempotencyRecords, record],
            activeTrainingPlanVersionId: trainingPlan.id
          },
          result: { trainingPlan, dailyEnergyTargets }
        };
      });
    },

    async getCurrentContext(userId: string): Promise<CurrentPlanningContext> {
      const state = await repository.read(userId);
      const trainingPlan = findById(
        state.trainingPlans,
        state.activeTrainingPlanVersionId
      );
      return {
        bodyProfile: findById(state.bodyProfiles, state.activeBodyProfileVersionId),
        goal: findById(state.goals, state.activeGoalVersionId),
        trainingPlan,
        dailyEnergyTargets: trainingPlan === null
          ? []
          : state.dailyEnergyTargets.filter(
            (target) => target.trainingPlanVersionId === trainingPlan.id
            ),
        latestVersions: {
          bodyProfile: state.bodyProfiles.length,
          goal: state.goals.length,
          trainingPlan: state.trainingPlans.length
        }
      };
    }
  };
}
