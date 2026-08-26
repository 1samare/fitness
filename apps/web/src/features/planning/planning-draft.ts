import type { PlanningSetupFormInput, TrainingDayFormInput } from './planning-form';

export const PLANNING_SETUP_DRAFT_KEY = 'fitness_local_v1_setup_draft';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrainingDay(value: unknown): value is TrainingDayFormInput {
  return isRecord(value)
    && typeof value.businessDate === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.sessionCode === 'string'
    && typeof value.durationMinutes === 'string';
}

function isPlanningSetupForm(value: unknown): value is PlanningSetupFormInput {
  if (!isRecord(value)) return false;
  const stringFields = [
    'ageYears', 'sexCode', 'heightCm', 'weightKg', 'nonTrainingActivity',
    'allergens', 'avoidFoods', 'dietPreferences', 'goal', 'targetWeightKg',
    'effectiveDate', 'targetDate', 'weekStartDate'
  ];
  return stringFields.every((field) => typeof value[field] === 'string')
    && typeof value.healthScopeConfirmed === 'boolean'
    && Array.isArray(value.trainingDays)
    && value.trainingDays.length === 7
    && value.trainingDays.every(isTrainingDay);
}

export function loadPlanningSetupDraft(storage: Storage): PlanningSetupFormInput | null {
  const stored = storage.getItem(PLANNING_SETUP_DRAFT_KEY);
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (isPlanningSetupForm(parsed)) return parsed;
  } catch {
    // Damaged drafts are discarded below and never reach domain commands.
  }
  storage.removeItem(PLANNING_SETUP_DRAFT_KEY);
  return null;
}

export function savePlanningSetupDraft(storage: Storage, form: PlanningSetupFormInput): void {
  storage.setItem(PLANNING_SETUP_DRAFT_KEY, JSON.stringify(form));
}

export function clearPlanningSetupDraft(storage: Storage): void {
  storage.removeItem(PLANNING_SETUP_DRAFT_KEY);
}
