import type { PlanningApiResponse } from '@fitness/contracts';
import type { CandidateDecision, MealSlot } from './form';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
export type CurrentContext = Extract<SuccessData, { kind: 'current_context' }>;
type PendingMealPlanTargetDiff = CurrentContext['pendingMealPlanTargetDiffs'][number];
type CompletePendingMealPlanTargetDiff = Extract<
  PendingMealPlanTargetDiff,
  { displayStatus: 'complete' }
>;
type WeeklyMealConflict = Extract<
  Extract<PlanningApiResponse, { success: false }>['error'],
  { code: 'nutrition_constraints_infeasible' }
>['conflicts'][number];
type PublicRecalculationJob = NonNullable<CurrentContext['retryableRecalculationJob']>;

export const MEAL_SLOT_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐'
} as const;

export interface MealDisplay {
  readonly slot: MealSlot;
  readonly slotLabel: string;
  readonly dishNameZh: string;
  readonly selectedRecipeIndex: number;
  readonly recipeLabels: readonly string[];
  readonly displayMessage: string;
  readonly ingredients: readonly {
    readonly displayNameZh: string;
    readonly gramsText: string;
  }[];
}

export interface MealDayDisplay {
  readonly businessDate: string;
  readonly locked: boolean;
  readonly manuallyModified: boolean;
  readonly statusText: string;
  readonly meals: readonly MealDisplay[];
  readonly ingredientSummaryText: string;
  readonly estimatedNutritionText: string;
}

export interface MealExecutionViewModel {
  readonly days: readonly MealDayDisplay[];
  readonly staleBanner: string;
  readonly pendingDiffs: readonly {
    readonly businessDate: string;
    readonly reasonText: string;
    readonly targetChangeText: string;
    readonly mealChangeText: string;
  }[];
  readonly recipeSelectionAvailable: boolean;
  readonly recipeAvailabilityMessage: string;
  readonly decisionOptions: readonly {
    readonly value: CandidateDecision;
    readonly label: string;
  }[];
  readonly decisionRecoveryMessage: string;
}

export interface CompletionFeedback {
  readonly factMessage: string;
  readonly mealMessage: string;
  readonly retryJobId: string;
  readonly needsStatusRefresh: boolean;
}

function nutrientNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function dayStatus(locked: boolean, manuallyModified: boolean): string {
  if (locked && manuallyModified) return '已锁定 · 已手动修改';
  if (locked) return '已锁定';
  if (manuallyModified) return '已手动修改';
  return '可调整';
}

function signedDelta(previous: number, proposed: number): string {
  const delta = proposed - previous;
  return `${delta >= 0 ? '+' : ''}${nutrientNumber(delta)}`;
}

function targetChangeText(diff: CurrentContext['pendingMealPlanTargetDiffs'][number]): string {
  if (diff.displayStatus === 'legacy_unavailable') return diff.displayMessage;
  const previous = diff.previousTarget;
  const proposed = diff.proposedTarget;
  return [
    `估算目标：能量 ${nutrientNumber(previous.estimatedEnergyKcal)}→${nutrientNumber(proposed.estimatedEnergyKcal)} 千卡（${signedDelta(previous.estimatedEnergyKcal, proposed.estimatedEnergyKcal)}）`,
    `蛋白质 ${nutrientNumber(previous.proteinG)}→${nutrientNumber(proposed.proteinG)} 克（${signedDelta(previous.proteinG, proposed.proteinG)}）`,
    `脂肪 ${nutrientNumber(previous.fatG)}→${nutrientNumber(proposed.fatG)} 克（${signedDelta(previous.fatG, proposed.fatG)}）`,
    `碳水 ${nutrientNumber(previous.carbohydrateG)}→${nutrientNumber(proposed.carbohydrateG)} 克（${signedDelta(previous.carbohydrateG, proposed.carbohydrateG)}）`,
    `纤维 ${nutrientNumber(previous.fiberRangeG.minInclusive)}–${nutrientNumber(previous.fiberRangeG.maxInclusive)}→${nutrientNumber(proposed.fiberRangeG.minInclusive)}–${nutrientNumber(proposed.fiberRangeG.maxInclusive)} 克`
  ].join('；');
}

function mealSnapshotText(meals: CompletePendingMealPlanTargetDiff['previousMeals']): string {
  return meals.map((meal) => {
    const ingredients = meal.ingredients
      .map((ingredient) => `${ingredient.displayNameZh} ${nutrientNumber(ingredient.grams)} 克`)
      .join('、');
    return `${MEAL_SLOT_LABELS[meal.slot]} ${meal.dishNameZh}（${ingredients}）`;
  }).join('；');
}

function mealChangeText(diff: CurrentContext['pendingMealPlanTargetDiffs'][number]): string {
  if (diff.displayStatus === 'legacy_unavailable') return '';
  const previous = mealSnapshotText(diff.previousMeals);
  const proposed = mealSnapshotText(diff.proposedMeals);
  return previous === proposed
    ? `菜品与克数保持不变：${previous}`
    : `菜品与克数：${previous} → ${proposed}`;
}

export function buildMealExecutionViewModel(context: CurrentContext): MealExecutionViewModel {
  const recipeLabels = context.selectableRecipes.map((recipe) => recipe.dishNameZh);
  const recipeNames = new Map(context.selectableRecipes.map((recipe, index) => [
    recipe.recipeTemplateVersionId,
    { dishNameZh: recipe.dishNameZh, index }
  ]));
  const days = (context.mealPlan?.days ?? [])
    .map((day): MealDayDisplay => {
      const totalGrams = day.ingredientAmounts.reduce((total, ingredient) => (
        total + ingredient.grams
      ), 0);
      const totals = day.nutritionTotals;
      return {
        businessDate: day.businessDate,
        locked: day.locked,
        manuallyModified: day.manuallyModified,
        statusText: dayStatus(day.locked, day.manuallyModified),
        meals: day.meals.map((meal) => {
          const recipe = recipeNames.get(meal.recipeTemplateVersionId);
          return {
            slot: meal.slot,
            slotLabel: MEAL_SLOT_LABELS[meal.slot],
            dishNameZh: meal.dishNameZh,
            selectedRecipeIndex: recipe?.index ?? 0,
            recipeLabels,
            displayMessage: meal.displayStatus === 'legacy_unavailable' ? meal.displayMessage : '',
            ingredients: meal.ingredients.map((ingredient) => ({
              displayNameZh: ingredient.displayNameZh,
              gramsText: `估算 ${nutrientNumber(ingredient.grams)} 克`
            }))
          };
        }),
        ingredientSummaryText: `${String(day.ingredientAmounts.length)} 种食材 · 合计 ${nutrientNumber(totalGrams)} 克`,
        estimatedNutritionText: [
          `估算 ${nutrientNumber(totals.energyKcal)} 千卡`,
          `蛋白质 ${nutrientNumber(totals.proteinG)} 克`,
          `脂肪 ${nutrientNumber(totals.fatG)} 克`,
          `碳水 ${nutrientNumber(totals.carbohydrateG)} 克`
        ].join(' · ')
      };
    })
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate));

  const hasCandidate = context.pendingMealPlanCandidate !== null;
  const hasLegacyCandidateDiff = hasCandidate
    && context.pendingMealPlanTargetDiffs.some((diff) => diff.displayStatus === 'legacy_unavailable');
  return {
    days,
    staleBanner: context.mealPlanStale
      ? '训练或营养目标已变化，当前餐单可能已过期。请处理待确认差异或重试重算。'
      : '',
    pendingDiffs: context.pendingMealPlanTargetDiffs
      .map((diff) => ({
        businessDate: diff.businessDate,
        reasonText: '该日已锁定或手动修改，新餐单不会静默覆盖。',
        targetChangeText: targetChangeText(diff),
        mealChangeText: mealChangeText(diff)
      }))
      .sort((left, right) => left.businessDate.localeCompare(right.businessDate)),
    recipeSelectionAvailable: context.selectableRecipesStatus === 'available'
      && context.selectableRecipes.length > 0,
    recipeAvailabilityMessage: context.selectableRecipesStatus === 'provider_unavailable'
      ? '备选菜品暂不可用。当前餐单仍可查看，请刷新备选菜品后重新选择。'
      : context.selectableRecipesStatus === 'no_options'
        ? '当前没有可替换的备选菜品。请刷新备选菜品或重新校验库存。'
        : '',
    decisionOptions: hasCandidate
      ? hasLegacyCandidateDiff
        ? [{ value: 'keep_existing', label: '保留当前锁定餐单' }]
        : [
            { value: 'keep_existing', label: '保留当前锁定餐单' },
            { value: 'overwrite_locked', label: '确认并覆盖锁定日' }
          ]
      : [],
    decisionRecoveryMessage: !hasCandidate
      ? ''
      : hasLegacyCandidateDiff
        ? '历史差异摘要不可用，不能安全覆盖；可保留现有计划或重新生成。'
        : '餐单差异仍待确认，请继续处理餐单差异。'
  };
}

export function mealPlanningErrorMessage(
  code: string,
  conflicts: readonly WeeklyMealConflict[] = []
): string {
  if (code === 'provider_unavailable') {
    return '营养数据暂时不可用，已有训练事实与餐单不会丢失。请稍后点击“重试餐单重算”。';
  }
  if (code === 'nutrition_constraints_infeasible') {
    const conflict = conflicts[0];
    if (conflict !== undefined) {
      const prefix = `${conflict.businessDate}：`;
      if (conflict.code === 'inventory_insufficient') {
        const foodName = conflict.foodNameZh === undefined ? '食材' : `“${conflict.foodNameZh}”`;
        const quantities = conflict.requiredGrams === undefined || conflict.availableGrams === undefined
          ? ''
          : `（需要 ${nutrientNumber(conflict.requiredGrams)} 克，可用 ${nutrientNumber(conflict.availableGrams)} 克）`;
        return `${prefix}${foodName}库存不足${quantities}。请补充该日所需食材后重新生成。`;
      }
      if (conflict.code === 'allergen_detected') {
        const foodName = conflict.foodNameZh === undefined ? '候选餐单' : `候选食材“${conflict.foodNameZh}”`;
        return `${prefix}${foodName}命中过敏原。请调整库存或过敏原设置后重新生成；过敏原不会被放宽。`;
      }
      if (conflict.code === 'avoided_food') {
        const foodName = conflict.foodNameZh === undefined ? '候选餐单' : `候选食材“${conflict.foodNameZh}”`;
        return `${prefix}${foodName}包含忌口食材。请调整库存或忌口设置后重新生成。`;
      }
      if (conflict.code === 'source_chain_incomplete') {
        const foodName = conflict.foodNameZh === undefined ? '' : `“${conflict.foodNameZh}”的`;
        return `${prefix}${foodName}审核营养来源不完整。请刷新数据来源后重新生成，系统不会使用缺失来源的数据。`;
      }
      if (conflict.code === 'nutrition_out_of_range') {
        return `${prefix}候选餐单的营养范围不符合目标。请调整可用食材后重新生成。`;
      }
      if (conflict.code === 'food_diversity_insufficient') {
        return `${prefix}食物种类不足。请补充不同食物组的食材后重新生成。`;
      }
      return `${prefix}当前营养目标不可用于一周餐单。请先返回规划页复核身体档案和目标。`;
    }
    return '现有食材无法满足营养与过敏原约束。请补充可用食材后重新生成；过敏原不会被放宽。';
  }
  if (code === 'version_conflict') return '内容已在其他位置更新，请刷新后再试。';
  if (code === 'recipe_not_selectable') return '备选菜品已更新，请刷新并重新选择。';
  if (code === 'past_fact_immutable') return '今天及过去日期的餐单事实不可修改，请选择未来日期。';
  if (code === 'future_completion_forbidden') return '训练完成记录不能填写未来日期，请选择今天或过去的计划训练日期。';
  return '操作未完成，请检查输入后重试。';
}

export function recalculationJobFailureMessage(job: PublicRecalculationJob): string {
  if (job.failureCode === 'nutrition_constraints_infeasible') {
    if (job.failureConflictDetailsStatus === 'legacy_unavailable') {
      return '历史失败详情不可用。请检查库存、过敏原和忌口设置后重新生成餐单。';
    }
    return mealPlanningErrorMessage(job.failureCode, job.failureConflicts);
  }
  return mealPlanningErrorMessage(job.failureCode ?? 'provider_unavailable');
}

export function buildCompletionFeedback(response: PlanningApiResponse): CompletionFeedback {
  if (!response.success) {
    return {
      factMessage: '',
      mealMessage: mealPlanningErrorMessage(
        response.error.code,
        response.error.code === 'nutrition_constraints_infeasible' ? response.error.conflicts : []
      ),
      retryJobId: '',
      needsStatusRefresh: false
    };
  }
  if (response.data.kind !== 'training_completion_recorded') {
    return { factMessage: '', mealMessage: '返回结果不匹配，请刷新后重试。', retryJobId: '', needsStatusRefresh: false };
  }
  if (response.data.recalculationStatus === 'failed_retryable') {
    return {
      factMessage: '训练完成情况已保存。',
      mealMessage: response.data.recalculationJob === null
        ? '餐单重算暂未完成，训练事实不受影响。请刷新状态后重试。'
        : recalculationJobFailureMessage(response.data.recalculationJob),
      retryJobId: response.data.recalculationJob?.id ?? '',
      needsStatusRefresh: response.data.recalculationJob === null
    };
  }
  if (response.data.recalculationStatus === 'pending_confirmation') {
    return {
      factMessage: '训练完成情况已保存。',
      mealMessage: '餐单变化涉及锁定或手动修改内容，请选择保留或覆盖。',
      retryJobId: '',
      needsStatusRefresh: false
    };
  }
  return {
    factMessage: '训练完成情况已保存。',
    mealMessage: response.data.recalculationStatus === 'completed'
      ? '后续餐单已按完成情况更新。'
      : '本次完成情况无需调整餐单。',
    retryJobId: '',
    needsStatusRefresh: false
  };
}
