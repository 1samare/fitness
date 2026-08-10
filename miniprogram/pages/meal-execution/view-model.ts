import type { PlanningApiResponse } from '@fitness/contracts';
import type { CandidateDecision, MealSlot } from './form';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
export type CurrentContext = Extract<SuccessData, { kind: 'current_context' }>;

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
  }[];
  readonly decisionOptions: readonly {
    readonly value: CandidateDecision;
    readonly label: string;
  }[];
}

export interface CompletionFeedback {
  readonly factMessage: string;
  readonly mealMessage: string;
  readonly retryJobId: string;
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
            dishNameZh: recipe?.dishNameZh ?? '当前菜品',
            selectedRecipeIndex: recipe?.index ?? 0,
            recipeLabels
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
  return {
    days,
    staleBanner: context.mealPlanStale
      ? '训练或营养目标已变化，当前餐单可能已过期。请处理待确认差异或重试重算。'
      : '',
    pendingDiffs: context.pendingMealPlanTargetDiffs
      .map((diff) => ({
        businessDate: diff.businessDate,
        reasonText: '该日已锁定或手动修改，新餐单不会静默覆盖。'
      }))
      .sort((left, right) => left.businessDate.localeCompare(right.businessDate)),
    decisionOptions: hasCandidate
      ? [
          { value: 'keep_existing', label: '保留当前锁定餐单' },
          { value: 'overwrite_locked', label: '确认并覆盖锁定日' }
        ]
      : []
  };
}

export function mealPlanningErrorMessage(code: string): string {
  if (code === 'provider_unavailable') {
    return '营养数据暂时不可用，已有训练事实与餐单不会丢失。请稍后点击“重试餐单重算”。';
  }
  if (code === 'nutrition_constraints_infeasible') {
    return '现有食材无法满足营养与过敏原约束。请补充可用食材后重新生成；过敏原不会被放宽。';
  }
  if (code === 'version_conflict') return '内容已在其他位置更新，请刷新后再试。';
  if (code === 'recipe_not_selectable') return '备选菜品已更新，请刷新并重新选择。';
  if (code === 'past_fact_immutable') return '今天及过去日期的餐单事实不可修改，请选择未来日期。';
  return '操作未完成，请检查输入后重试。';
}

export function buildCompletionFeedback(response: PlanningApiResponse): CompletionFeedback {
  if (!response.success) {
    return {
      factMessage: '',
      mealMessage: mealPlanningErrorMessage(response.error.code),
      retryJobId: ''
    };
  }
  if (response.data.kind !== 'training_completion_recorded') {
    return { factMessage: '', mealMessage: '返回结果不匹配，请刷新后重试。', retryJobId: '' };
  }
  if (response.data.recalculationStatus === 'failed_retryable') {
    return {
      factMessage: '训练完成情况已保存。',
      mealMessage: '餐单重算暂未完成，训练事实不受影响。请稍后重试。',
      retryJobId: response.data.recalculationJob?.id ?? ''
    };
  }
  if (response.data.recalculationStatus === 'pending_confirmation') {
    return {
      factMessage: '训练完成情况已保存。',
      mealMessage: '餐单变化涉及锁定或手动修改内容，请选择保留或覆盖。',
      retryJobId: ''
    };
  }
  return {
    factMessage: '训练完成情况已保存。',
    mealMessage: response.data.recalculationStatus === 'completed'
      ? '后续餐单已按完成情况更新。'
      : '本次完成情况无需调整餐单。',
    retryJobId: ''
  };
}
