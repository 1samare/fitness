import {
  addBusinessDays,
  businessDateSchema,
  planningSetupPayloadSchema,
  type PlanningApiRequest,
  type PlanningSetupPayload
} from '@fitness/contracts';
import { REVIEWED_MET_DATASET } from '@fitness/met-sessions';

type SetupRequest = Extract<PlanningApiRequest, { action: 'completePlanningSetup' }>;
type BodyProfileRequest = Extract<PlanningApiRequest, { action: 'saveBodyProfile' }>;
type GoalRequest = Extract<PlanningApiRequest, { action: 'saveGoal' }>;
type TrainingPlanRequest = Extract<PlanningApiRequest, { action: 'saveTrainingPlan' }>;

export type PlanningVersions = SetupRequest['payload']['expectedVersions'];

interface CommonPlanningSetupFormInput {
  readonly ageYears: string;
  readonly sexCode: string;
  readonly heightCm: string;
  readonly weightKg: string;
  readonly healthScopeConfirmed: boolean;
  readonly activity: string;
  readonly allergens: string;
  readonly avoidFoods: string;
  readonly dietPreferences: string;
  readonly goal: string;
  readonly targetWeightKg: string;
  readonly effectiveDate: string;
  readonly targetDate: string;
  readonly weekStartDate: string;
}

export interface TrainingDayFormInput {
  readonly businessDate: string;
  readonly enabled: boolean;
  readonly disabled: boolean;
  readonly sessionCode: string;
  readonly durationMinutes: string;
}

export interface PlanningSetupFormInput extends CommonPlanningSetupFormInput {
  readonly trainingDays: readonly TrainingDayFormInput[];
}

export interface LegacyPlanningSetupFormInput extends CommonPlanningSetupFormInput {
  readonly trainingDate: string;
  readonly durationMinutes: string;
}

export type PlanningSetupPayloadBuildResult =
  | { readonly kind: 'valid'; readonly payload: PlanningSetupPayload }
  | { readonly kind: 'invalid'; readonly message: string };

export interface PlanningIdempotencyKeys {
  readonly bodyProfile: string;
  readonly goal: string;
  readonly trainingPlan: string;
}

export type PlanningSetupBuildResult =
  | {
      readonly kind: 'valid';
      readonly bodyProfile: BodyProfileRequest;
      readonly goal: GoalRequest;
      readonly trainingPlan: TrainingPlanRequest;
    }
  | { readonly kind: 'invalid'; readonly message: string };

const reviewedSessionCodes: ReadonlySet<string> = new Set(
  REVIEWED_MET_DATASET.sessions.map((session) => session.code)
);

function splitList(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isActivity(value: string): value is 'light' | 'moderate' | 'heavy' {
  return value === 'light' || value === 'moderate' || value === 'heavy';
}

function isGoal(value: string): value is 'maintain' | 'fat_loss' | 'muscle_gain' {
  return value === 'maintain' || value === 'fat_loss' || value === 'muscle_gain';
}

function validBusinessDate(value: string): boolean {
  return businessDateSchema.safeParse(value).success;
}

export function buildTrainingDayRows(
  weekStartDate: string,
  businessToday: string,
  goalEffectiveDate: string,
  goalTargetDate: string
): TrainingDayFormInput[] {
  if (
    !validBusinessDate(weekStartDate)
    || !validBusinessDate(businessToday)
    || !validBusinessDate(goalEffectiveDate)
    || !validBusinessDate(goalTargetDate)
    || goalTargetDate < goalEffectiveDate
  ) {
    throw new RangeError('Invalid weekly planning date range');
  }
  const eligibleStart = businessToday >= goalEffectiveDate
    ? businessToday
    : goalEffectiveDate;
  return Array.from({ length: 7 }, (_, index) => {
    const businessDate = addBusinessDays(weekStartDate, index);
    return {
      businessDate,
      enabled: false,
      disabled: businessDate < eligibleStart || businessDate > goalTargetDate,
      sessionCode: '',
      durationMinutes: ''
    };
  });
}

export function buildPlanningSetupPayload(
  form: PlanningSetupFormInput
): PlanningSetupPayloadBuildResult {
  if (!form.healthScopeConfirmed) {
    return { kind: 'invalid', message: '请先完成健康适用范围确认。' };
  }
  const ageYears = positiveNumber(form.ageYears);
  const heightCm = positiveNumber(form.heightCm);
  const weightKg = positiveNumber(form.weightKg);
  if (ageYears === undefined || !Number.isInteger(ageYears)) {
    return { kind: 'invalid', message: '请输入有效的整数年龄。' };
  }
  if (heightCm === undefined || weightKg === undefined) {
    return { kind: 'invalid', message: '请输入有效的身高和体重。' };
  }
  if (form.sexCode !== '0' && form.sexCode !== '1') {
    return { kind: 'invalid', message: '请选择公式所需性别。' };
  }
  if (!isActivity(form.activity)) {
    return { kind: 'invalid', message: '请选择不含训练的日常活动等级。' };
  }
  if (!isGoal(form.goal)) {
    return { kind: 'invalid', message: '请选择健身目标。' };
  }
  if (!validBusinessDate(form.weekStartDate) || form.trainingDays.length !== 7) {
    return { kind: 'invalid', message: '请选择有效规划周并保留完整七天。' };
  }
  const expectedDates = Array.from(
    { length: 7 },
    (_, index) => addBusinessDays(form.weekStartDate, index)
  );
  if (form.trainingDays.some((row, index) => row.businessDate !== expectedDates[index])) {
    return { kind: 'invalid', message: '训练日期必须与当前规划周一致。' };
  }

  const sessions: Array<{
    businessDate: string;
    sessionCode: string;
    durationMinutes: number;
  }> = [];
  for (const row of form.trainingDays) {
    if (row.disabled || !row.enabled) continue;
    const durationMinutes = positiveNumber(row.durationMinutes);
    if (!reviewedSessionCodes.has(row.sessionCode) || durationMinutes === undefined) {
      return {
        kind: 'invalid',
        message: '已启用的训练日必须选择审核动作并填写有效分钟数。'
      };
    }
    sessions.push({
      businessDate: row.businessDate,
      sessionCode: row.sessionCode,
      durationMinutes
    });
  }

  const targetWeightKg = form.targetWeightKg.length === 0
    ? undefined
    : positiveNumber(form.targetWeightKg);
  if (form.targetWeightKg.length > 0 && targetWeightKg === undefined) {
    return { kind: 'invalid', message: '请输入有效目标体重。' };
  }
  const payload = {
    bodyProfile: {
      ageYears,
      sexCode: form.sexCode === '0' ? 0 : 1,
      heightCm,
      weightKg,
      healthScopeConfirmed: form.healthScopeConfirmed,
      nonTrainingActivity: form.activity,
      allergens: splitList(form.allergens),
      avoidFoods: splitList(form.avoidFoods),
      dietPreferences: splitList(form.dietPreferences),
      businessTimezone: 'Asia/Shanghai'
    },
    goal: {
      goal: form.goal,
      effectiveDate: form.effectiveDate,
      targetDate: form.targetDate,
      ...(targetWeightKg === undefined ? {} : { targetWeightKg })
    },
    trainingPlan: {
      weekStartDate: form.weekStartDate,
      businessTimezone: 'Asia/Shanghai',
      sessions
    }
  };
  const parsed = planningSetupPayloadSchema.safeParse(payload);
  return parsed.success
    ? { kind: 'valid', payload: parsed.data }
    : { kind: 'invalid', message: '请检查日期、数值范围和训练计划。' };
}

export function buildPlanningSetupRequests(
  form: LegacyPlanningSetupFormInput,
  versions: PlanningVersions,
  keys: PlanningIdempotencyKeys
): PlanningSetupBuildResult {
  const hasTrainingDate = form.trainingDate.length > 0;
  const hasDuration = form.durationMinutes.length > 0;
  if (hasTrainingDate !== hasDuration) {
    return { kind: 'invalid', message: '训练日期和有效分钟数必须同时填写。' };
  }

  let trainingDays: TrainingDayFormInput[];
  try {
    trainingDays = buildTrainingDayRows(
      form.weekStartDate,
      form.weekStartDate,
      form.effectiveDate,
      form.targetDate
    );
  } catch {
    return { kind: 'invalid', message: '请填写有效的目标和计划日期。' };
  }
  if (hasTrainingDate) {
    const reviewedSession = REVIEWED_MET_DATASET.sessions[0];
    const matched = trainingDays.some((row) => row.businessDate === form.trainingDate);
    if (!matched) return { kind: 'invalid', message: '训练日期必须位于当前规划周。' };
    trainingDays = trainingDays.map((row) => (
      row.businessDate === form.trainingDate
        ? {
            ...row,
            enabled: true,
            sessionCode: reviewedSession.code,
            durationMinutes: form.durationMinutes
          }
        : row
    ));
  }

  const built = buildPlanningSetupPayload({ ...form, trainingDays });
  if (built.kind === 'invalid') return built;
  return {
    kind: 'valid',
    bodyProfile: {
      action: 'saveBodyProfile',
      payload: {
        expectedVersion: versions.bodyProfile,
        idempotencyKey: keys.bodyProfile,
        payload: built.payload.bodyProfile
      }
    },
    goal: {
      action: 'saveGoal',
      payload: {
        expectedVersion: versions.goal,
        idempotencyKey: keys.goal,
        payload: built.payload.goal
      }
    },
    trainingPlan: {
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: versions.trainingPlan,
        idempotencyKey: keys.trainingPlan,
        payload: built.payload.trainingPlan
      }
    }
  };
}
