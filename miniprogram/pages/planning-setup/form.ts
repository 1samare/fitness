import type { PlanningApiRequest } from '@fitness/contracts';

type BodyProfileRequest = Extract<PlanningApiRequest, { action: 'saveBodyProfile' }>;
type GoalRequest = Extract<PlanningApiRequest, { action: 'saveGoal' }>;
type TrainingPlanRequest = Extract<PlanningApiRequest, { action: 'saveTrainingPlan' }>;

export interface PlanningSetupFormInput {
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
  readonly trainingDate: string;
  readonly durationMinutes: string;
}

export interface PlanningVersions {
  readonly bodyProfile: number;
  readonly goal: number;
  readonly trainingPlan: number;
}

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

export function buildPlanningSetupRequests(
  form: PlanningSetupFormInput,
  versions: PlanningVersions,
  keys: PlanningIdempotencyKeys
): PlanningSetupBuildResult {
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
  if (
    form.effectiveDate.length === 0
    || form.targetDate.length === 0
    || form.weekStartDate.length === 0
  ) {
    return { kind: 'invalid', message: '请填写目标和计划日期。' };
  }

  const hasTrainingDate = form.trainingDate.length > 0;
  const hasDuration = form.durationMinutes.length > 0;
  if (hasTrainingDate !== hasDuration) {
    return { kind: 'invalid', message: '训练日期和有效分钟数必须同时填写。' };
  }
  const durationMinutes = hasDuration ? positiveNumber(form.durationMinutes) : undefined;
  if (hasDuration && durationMinutes === undefined) {
    return { kind: 'invalid', message: '请输入有效训练分钟数。' };
  }

  const targetWeightKg = form.targetWeightKg.length === 0
    ? undefined
    : positiveNumber(form.targetWeightKg);
  if (form.targetWeightKg.length > 0 && targetWeightKg === undefined) {
    return { kind: 'invalid', message: '请输入有效目标体重。' };
  }

  const goalPayload = {
    goal: form.goal,
    effectiveDate: form.effectiveDate,
    targetDate: form.targetDate,
    ...(targetWeightKg === undefined ? {} : { targetWeightKg })
  };
  const sessions = !hasTrainingDate || durationMinutes === undefined
    ? []
    : [{
        businessDate: form.trainingDate,
        sessionCode: '02054',
        durationMinutes
      }];

  return {
    kind: 'valid',
    bodyProfile: {
      action: 'saveBodyProfile',
      payload: {
        expectedVersion: versions.bodyProfile,
        idempotencyKey: keys.bodyProfile,
        payload: {
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
        }
      }
    },
    goal: {
      action: 'saveGoal',
      payload: {
        expectedVersion: versions.goal,
        idempotencyKey: keys.goal,
        payload: goalPayload
      }
    },
    trainingPlan: {
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: versions.trainingPlan,
        idempotencyKey: keys.trainingPlan,
        payload: {
          weekStartDate: form.weekStartDate,
          businessTimezone: 'Asia/Shanghai',
          sessions
        }
      }
    }
  };
}
