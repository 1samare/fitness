import {
  addBusinessDays,
  businessDateSchema,
  planningSetupPayloadSchema,
  type PlanningSetupPayload
} from '@fitness/contracts';
import { REVIEWED_MET_DATASET } from '@fitness/met-sessions';

export interface TrainingDayFormInput {
  readonly businessDate: string;
  readonly enabled: boolean;
  readonly sessionCode: string;
  readonly durationMinutes: string;
}

export interface PlanningSetupFormInput {
  readonly ageYears: string;
  readonly sexCode: string;
  readonly heightCm: string;
  readonly weightKg: string;
  readonly healthScopeConfirmed: boolean;
  readonly nonTrainingActivity: string;
  readonly allergens: string;
  readonly avoidFoods: string;
  readonly dietPreferences: string;
  readonly goal: string;
  readonly targetWeightKg: string;
  readonly effectiveDate: string;
  readonly targetDate: string;
  readonly weekStartDate: string;
  readonly trainingDays: readonly TrainingDayFormInput[];
}

export type PlanningSetupPayloadBuildResult =
  | { readonly kind: 'valid'; readonly payload: PlanningSetupPayload }
  | { readonly kind: 'invalid'; readonly message: string };

export const REVIEWED_TRAINING_OPTIONS = REVIEWED_MET_DATASET.sessions.map((session) => ({
  code: session.code,
  label: session.displayNameZh
}));

const reviewedSessionCodes: ReadonlySet<string> = new Set(
  REVIEWED_TRAINING_OPTIONS.map((session) => session.code)
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

function validBusinessDate(value: string): boolean {
  return businessDateSchema.safeParse(value).success;
}

function isActivity(value: string): value is 'light' | 'moderate' | 'heavy' {
  return value === 'light' || value === 'moderate' || value === 'heavy';
}

function isGoal(value: string): value is 'maintain' | 'fat_loss' | 'muscle_gain' {
  return value === 'maintain' || value === 'fat_loss' || value === 'muscle_gain';
}

export function buildTrainingDayRows(weekStartDate: string): TrainingDayFormInput[] {
  if (!validBusinessDate(weekStartDate)) throw new RangeError('Invalid week start date');
  return Array.from({ length: 7 }, (_, index) => ({
    businessDate: addBusinessDays(weekStartDate, index),
    enabled: false,
    sessionCode: '',
    durationMinutes: ''
  }));
}

export function createDefaultPlanningSetupForm(
  businessToday: string
): PlanningSetupFormInput {
  if (!validBusinessDate(businessToday)) throw new RangeError('Invalid business date');
  return {
    ageYears: '30',
    sexCode: '0',
    heightCm: '175',
    weightKg: '60',
    healthScopeConfirmed: true,
    nonTrainingActivity: 'light',
    allergens: '',
    avoidFoods: '',
    dietPreferences: '',
    goal: 'maintain',
    targetWeightKg: '',
    effectiveDate: businessToday,
    targetDate: addBusinessDays(businessToday, 84),
    weekStartDate: businessToday,
    trainingDays: buildTrainingDayRows(businessToday)
  };
}

export function buildPlanningSetupPayload(
  form: PlanningSetupFormInput
): PlanningSetupPayloadBuildResult {
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
  if (!isActivity(form.nonTrainingActivity)) {
    return { kind: 'invalid', message: '请选择不含训练的日常活动等级。' };
  }
  if (!isGoal(form.goal)) {
    return { kind: 'invalid', message: '请选择健身目标。' };
  }
  if (
    !validBusinessDate(form.effectiveDate)
    || !validBusinessDate(form.targetDate)
    || !validBusinessDate(form.weekStartDate)
    || form.targetDate < form.effectiveDate
    || form.trainingDays.length !== 7
  ) {
    return { kind: 'invalid', message: '请检查目标日期和完整七日规划周。' };
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
    if (!row.enabled) continue;
    const durationMinutes = positiveNumber(row.durationMinutes);
    if (!reviewedSessionCodes.has(row.sessionCode) || durationMinutes === undefined) {
      return {
        kind: 'invalid',
        message: '已启用的训练日必须选择审核训练类别并填写有效分钟数。'
      };
    }
    sessions.push({
      businessDate: row.businessDate,
      sessionCode: row.sessionCode,
      durationMinutes
    });
  }

  const targetWeightKg = form.targetWeightKg === ''
    ? undefined
    : positiveNumber(form.targetWeightKg);
  if (form.targetWeightKg !== '' && targetWeightKg === undefined) {
    return { kind: 'invalid', message: '请输入有效目标体重。' };
  }
  const candidate = {
    bodyProfile: {
      ageYears,
      sexCode: form.sexCode === '0' ? 0 as const : 1 as const,
      heightCm,
      weightKg,
      healthScopeConfirmed: form.healthScopeConfirmed,
      nonTrainingActivity: form.nonTrainingActivity,
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
  const parsed = planningSetupPayloadSchema.safeParse(candidate);
  return parsed.success
    ? { kind: 'valid', payload: parsed.data }
    : { kind: 'invalid', message: '请检查日期、数值范围和训练计划。' };
}
