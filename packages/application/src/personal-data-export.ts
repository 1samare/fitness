import { createHash } from 'node:crypto';
import {
  latestIngredientPhotoVersions,
  type DailyEnergyResult,
  type MealDisplaySnapshot,
  type MealTargetDisplaySnapshot,
  type NutritionTargetResult,
  type PlanningAggregateState
} from '@fitness/domain';

type ExportScalar = string | number | boolean | null | readonly string[];
type ExportData = Readonly<Record<string, ExportScalar>>;

export type PersonalDataExportRecord = {
  readonly category:
    | 'body_profile'
    | 'fitness_goal'
    | 'training_plan'
    | 'daily_energy_target'
    | 'daily_nutrition_target'
    | 'inventory'
    | 'meal_plan'
    | 'meal_plan_target_diff'
    | 'meal_plan_decision'
    | 'training_completion'
    | 'ingredient_photo_confirmation'
    | 'assistant_message';
  readonly contentOrigin: 'user' | 'ai_assisted' | 'deterministic';
  readonly recordVersion: number | null;
  readonly recordedAt: string | null;
  readonly data: ExportData;
};

export const PERSONAL_DATA_EXPORT_NOTICE = (
  '包含 AI 辅助生成内容与确定性估算；仅供健康成年人健身规划参考，不构成医疗建议。'
) as const;

export interface PersonalDataExportV1 {
  readonly kind: 'personal_data_export';
  readonly schemaVersion: 'personal-data-export-v1';
  readonly snapshotToken: string;
  readonly exportedAt: string;
  readonly notice: typeof PERSONAL_DATA_EXPORT_NOTICE;
  readonly provenance: {
    readonly policyVersions: readonly string[];
    readonly reviewedDataVersionReferences: readonly string[];
  };
  readonly records: readonly PersonalDataExportRecord[];
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalize(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Snapshot state must contain finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry === undefined ? null : canonicalize(entry));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)] as const)
    );
  }
  throw new TypeError('Snapshot state must be JSON serializable');
}

export function computePersonalDataSnapshotToken(state: PlanningAggregateState): string {
  const { accountDeletion, ...normalized } = state;
  void accountDeletion;
  const canonicalJson = JSON.stringify(canonicalize(normalized));
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function energyData(energy: DailyEnergyResult): ExportData {
  if (energy.kind === 'unsupported') {
    return {
      estimateStatus: 'unsupported',
      unsupportedCode: energy.code,
      unsupportedReasons: [...energy.reasons],
      bmiEstimate: energy.bmi,
      energyPolicyVersion: energy.policy.policyVersion
    };
  }
  return {
    estimateStatus: 'estimated',
    bmiEstimate: energy.bmi,
    estimatedBmrKcal: energy.estimatedBmrKcal,
    estimatedNonTrainingBaselineKcal: energy.nonTrainingBaselineKcal,
    estimatedTrainingNetKcal: energy.trainingNetKcal,
    estimatedMaintenanceKcal: energy.estimatedMaintenanceKcal,
    estimatedTargetEnergyKcal: energy.targetEnergyKcal,
    energyPolicyVersion: energy.policy.policyVersion
  };
}

function nutritionData(nutrition: NutritionTargetResult | null): ExportData {
  if (nutrition === null) return { nutritionStatus: 'unavailable' };
  if (nutrition.kind === 'infeasible') {
    return {
      nutritionStatus: 'infeasible',
      infeasibleCode: nutrition.code,
      conflictCodes: nutrition.conflicts.map((conflict) => conflict.code),
      estimatedTargetEnergyKcal: nutrition.targetEnergyKcal,
      nutritionPolicyVersion: nutrition.policy.policyVersion
    };
  }
  return {
    nutritionStatus: 'estimated',
    estimatedTargetEnergyKcal: nutrition.targetEnergyKcal,
    estimatedProteinG: nutrition.proteinG,
    estimatedFatG: nutrition.fatG,
    estimatedCarbohydrateG: nutrition.carbohydrateG,
    estimatedProteinEnergyPercent: nutrition.proteinEnergyPercent,
    estimatedFatEnergyPercent: nutrition.fatEnergyPercent,
    estimatedCarbohydrateEnergyPercent: nutrition.carbohydrateEnergyPercent,
    estimatedFiberMinimumG: nutrition.fiberRangeG.minInclusive,
    estimatedFiberMaximumG: nutrition.fiberRangeG.maxInclusive,
    estimatedSaturatedFatMaximumExclusiveG: nutrition.saturatedFatMaxExclusiveG,
    estimatedAddedSugarMaximumExclusiveG: nutrition.addedSugarMaxExclusiveG,
    nutritionPolicyVersion: nutrition.policy.policyVersion
  };
}

function targetSnapshotJson(value: MealTargetDisplaySnapshot | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify({
    estimatedEnergyKcal: value.estimatedEnergyKcal,
    proteinG: value.proteinG,
    fatG: value.fatG,
    carbohydrateG: value.carbohydrateG,
    fiberMinimumG: value.fiberRangeG.minInclusive,
    fiberMaximumG: value.fiberRangeG.maxInclusive
  });
}

function mealSnapshotsJson(value: readonly MealDisplaySnapshot[] | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value.map((meal) => ({
    slot: meal.slot,
    dishNameZh: meal.dishNameZh,
    ingredients: meal.ingredients.map((ingredient) => ({
      displayNameZh: ingredient.displayNameZh,
      grams: ingredient.grams
    }))
  })));
}

function visibleFoodNames(state: PlanningAggregateState): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const photo of state.ingredientPhotoVersions) {
    for (const candidate of photo.candidates) {
      names.set(candidate.foodId, candidate.canonicalNameZh);
    }
  }
  return names;
}

function projectRecords(state: PlanningAggregateState): readonly PersonalDataExportRecord[] {
  const records: PersonalDataExportRecord[] = [];
  const foodNames = visibleFoodNames(state);

  for (const profile of state.bodyProfiles) {
    records.push({
      category: 'body_profile',
      contentOrigin: 'user',
      recordVersion: profile.version,
      recordedAt: profile.createdAt,
      data: {
        ageYears: profile.payload.ageYears,
        sex: profile.payload.sexCode === 0 ? '男' : '女',
        heightCm: profile.payload.heightCm,
        weightKg: profile.payload.weightKg,
        healthScopeConfirmed: profile.payload.healthScopeConfirmed,
        nonTrainingActivity: profile.payload.nonTrainingActivity,
        allergens: profile.payload.allergens,
        avoidedFoods: profile.payload.avoidFoods,
        dietPreferences: profile.payload.dietPreferences,
        businessTimezone: profile.payload.businessTimezone
      }
    });
  }

  for (const goal of state.goals) {
    records.push({
      category: 'fitness_goal',
      contentOrigin: 'user',
      recordVersion: goal.version,
      recordedAt: goal.createdAt,
      data: {
        goal: goal.payload.goal,
        targetWeightKg: goal.payload.targetWeightKg ?? null,
        effectiveDate: goal.payload.effectiveDate,
        targetDate: goal.payload.targetDate
      }
    });
  }

  for (const plan of state.trainingPlans) {
    records.push({
      category: 'training_plan',
      contentOrigin: 'user',
      recordVersion: plan.version,
      recordedAt: plan.createdAt,
      data: {
        weekStartDate: plan.payload.weekStartDate,
        businessTimezone: plan.payload.businessTimezone,
        sessionsJson: JSON.stringify(plan.payload.sessions.map((session) => ({
          businessDate: session.businessDate,
          reviewedSessionCode: session.sessionCode,
          durationMinutes: session.durationMinutes
        })))
      }
    });
  }

  for (const target of state.dailyEnergyTargets) {
    records.push({
      category: 'daily_energy_target',
      contentOrigin: 'deterministic',
      recordVersion: target.version,
      recordedAt: target.createdAt,
      data: {
        businessDate: target.businessDate,
        energyPolicyVersion: target.energyPolicyVersion,
        nutritionPolicyVersion: target.nutritionPolicyVersion,
        ...energyData(target.energy)
      }
    });
  }

  for (const target of state.dailyNutritionTargets) {
    records.push({
      category: 'daily_nutrition_target',
      contentOrigin: 'deterministic',
      recordVersion: target.version,
      recordedAt: target.createdAt,
      data: {
        businessDate: target.businessDate,
        energyPolicyVersion: target.energyPolicyVersion,
        nutritionPolicyVersion: target.nutritionPolicyVersion,
        ...nutritionData(target.nutrition)
      }
    });
  }

  for (const inventory of state.inventories) {
    records.push({
      category: 'inventory',
      contentOrigin: 'user',
      recordVersion: inventory.version,
      recordedAt: inventory.createdAt,
      data: {
        itemsJson: JSON.stringify(inventory.items.map((item) => ({
          foodNameZh: foodNames.get(item.foodId) ?? '未保存展示名称',
          availableGrams: item.availableGrams,
          reviewedSourceVersionReference: item.nutritionSnapshotId
        })))
      }
    });
  }

  for (const plan of state.mealPlans) {
    records.push({
      category: 'meal_plan',
      contentOrigin: 'deterministic',
      recordVersion: plan.version,
      recordedAt: plan.createdAt,
      data: {
        weekStartDate: plan.weekStartDate,
        generationPolicyVersion: plan.generationPolicyVersion,
        readiness: plan.readiness,
        daysJson: JSON.stringify(plan.days.map((day) => ({
          businessDate: day.businessDate,
          locked: day.locked,
          manuallyModified: day.manuallyModified,
          meals: day.meals.map((meal) => ({
            slot: meal.slot,
            dishNameZh: meal.dishNameZh ?? '未保存菜名',
            servingMultiplier: meal.servingMultiplier,
            ingredients: (meal.ingredients ?? []).map((ingredient) => ({
              displayNameZh: ingredient.displayNameZh,
              grams: ingredient.grams
            }))
          })),
          ingredients: day.ingredientAmounts.map((ingredient) => ({
            foodNameZh: foodNames.get(ingredient.foodId) ?? '未保存展示名称',
            grams: ingredient.grams
          })),
          nutritionTotals: {
            energyKcal: day.nutritionTotals.energyKcal,
            proteinG: day.nutritionTotals.proteinG,
            fatG: day.nutritionTotals.fatG,
            carbohydrateG: day.nutritionTotals.carbohydrateG,
            fiberG: day.nutritionTotals.fiberG,
            saturatedFatG: day.nutritionTotals.saturatedFatG,
            addedSugarG: day.nutritionTotals.addedSugarG
          },
          reviewedSourceVersionReferences: day.nutritionSourceSnapshotIds
        })))
      }
    });
  }

  for (const diff of state.mealPlanTargetDiffs) {
    records.push({
      category: 'meal_plan_target_diff',
      contentOrigin: 'deterministic',
      recordVersion: null,
      recordedAt: null,
      data: {
        businessDate: diff.businessDate,
        reason: diff.reason,
        previousTargetJson: targetSnapshotJson(diff.previousTarget),
        proposedTargetJson: targetSnapshotJson(diff.proposedTarget),
        previousMealsJson: mealSnapshotsJson(diff.previousMeals),
        proposedMealsJson: mealSnapshotsJson(diff.proposedMeals)
      }
    });
  }

  for (const decision of state.mealPlanDecisions) {
    records.push({
      category: 'meal_plan_decision',
      contentOrigin: 'user',
      recordVersion: decision.version,
      recordedAt: decision.decidedAt,
      data: { decision: decision.decision }
    });
  }

  for (const completion of state.trainingCompletionEvents) {
    records.push({
      category: 'training_completion',
      contentOrigin: 'user',
      recordVersion: completion.version,
      recordedAt: completion.occurredAt,
      data: {
        businessDate: completion.businessDate,
        completedDurationMinutes: completion.completedDurationMinutes
      }
    });
  }

  for (const photo of latestIngredientPhotoVersions(state.ingredientPhotoVersions)) {
    const confirmed = photo.candidates.find(
      (candidate) => candidate.id === photo.confirmedCandidateId
    );
    records.push({
      category: 'ingredient_photo_confirmation',
      contentOrigin: 'ai_assisted',
      recordVersion: photo.revision,
      recordedAt: photo.createdAt,
      data: {
        recognitionStatus: photo.workflowStatus,
        candidatesJson: JSON.stringify(photo.candidates.map((candidate) => ({
          canonicalNameZh: candidate.canonicalNameZh,
          confidence: candidate.confidence,
          foodState: candidate.foodState
        }))),
        confirmationStatus: photo.confirmedCandidateId === null ? 'not_confirmed' : 'confirmed',
        confirmedCanonicalNameZh: confirmed?.canonicalNameZh ?? null,
        confirmedGrams: photo.confirmedGrams,
        uploadCreatedAt: photo.uploadCreatedAt
      }
    });
  }

  for (const message of state.assistantConversation.recentMessages) {
    records.push({
      category: 'assistant_message',
      contentOrigin: message.role === 'assistant' ? 'ai_assisted' : 'user',
      recordVersion: null,
      recordedAt: message.createdAt,
      data: { role: message.role, content: message.content }
    });
  }

  return records;
}

export function projectPersonalDataExport(
  state: PlanningAggregateState,
  snapshotToken: string,
  exportedAt: string
): PersonalDataExportV1 {
  const policyVersions = sortedUnique([
    ...state.dailyEnergyTargets.flatMap((target) => [
      target.energyPolicyVersion,
      target.nutritionPolicyVersion,
      target.energy.policy.policyVersion
    ]),
    ...state.dailyNutritionTargets.flatMap((target) => [
      target.energyPolicyVersion,
      target.nutritionPolicyVersion,
      ...(target.nutrition === null ? [] : [target.nutrition.policy.policyVersion])
    ]),
    ...state.mealPlans.map((plan) => plan.generationPolicyVersion)
  ]);
  const reviewedDataVersionReferences = sortedUnique([
    ...state.inventories.flatMap((inventory) => (
      inventory.items.map((item) => item.nutritionSnapshotId)
    )),
    ...state.mealPlans.flatMap((plan) => (
      plan.days.flatMap((day) => day.nutritionSourceSnapshotIds)
    )),
    ...state.ingredientPhotoVersions.flatMap((photo) => (
      photo.candidates.map((candidate) => candidate.nutritionSnapshotId)
    ))
  ]);
  return {
    kind: 'personal_data_export',
    schemaVersion: 'personal-data-export-v1',
    snapshotToken,
    exportedAt,
    notice: PERSONAL_DATA_EXPORT_NOTICE,
    provenance: { policyVersions, reviewedDataVersionReferences },
    records: projectRecords(state)
  };
}
