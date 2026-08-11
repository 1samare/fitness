import type { PlanningApiResponse } from '@fitness/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildCompletionFeedback,
  buildMealExecutionViewModel,
  mealPlanningErrorMessage
} from './view-model';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type CurrentContext = Extract<SuccessData, { kind: 'current_context' }>;

const dates = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
  '2026-08-21', '2026-08-22', '2026-08-23'
] as const;

function contextFixture(): CurrentContext {
  const recipes = [
    { recipeTemplateVersionId: 'recipe-breakfast', dishNameZh: '测试早餐' },
    { recipeTemplateVersionId: 'recipe-lunch', dishNameZh: '测试午餐' },
    { recipeTemplateVersionId: 'recipe-dinner', dishNameZh: '测试晚餐' },
    { recipeTemplateVersionId: 'recipe-snack', dishNameZh: '测试加餐' }
  ] as const;
  const days = [...dates].reverse().map((businessDate, reverseIndex) => {
    const index = dates.length - reverseIndex - 1;
    return {
      businessDate,
      dailyNutritionTargetVersionId: `target-${businessDate}`,
      dailyMenuTemplateVersionId: `menu-${businessDate}`,
      locked: index === 1,
      manuallyModified: index === 2,
      meals: [
        {
          slot: 'breakfast' as const,
          recipeTemplateVersionId: 'recipe-breakfast',
          servingMultiplier: 1,
          displayStatus: 'complete' as const,
          dishNameZh: '测试早餐',
          ingredients: [
            { displayNameZh: '测试米饭', grams: 100 },
            { displayNameZh: '测试鸡蛋', grams: 50 }
          ]
        },
        {
          slot: 'lunch' as const,
          recipeTemplateVersionId: 'recipe-lunch',
          servingMultiplier: 1,
          displayStatus: 'complete' as const,
          dishNameZh: '测试午餐',
          ingredients: [
            { displayNameZh: '测试鸡胸肉', grams: 120 },
            { displayNameZh: '测试蔬菜', grams: 180 }
          ]
        },
        {
          slot: 'dinner' as const,
          recipeTemplateVersionId: 'recipe-dinner',
          servingMultiplier: 1,
          displayStatus: 'complete' as const,
          dishNameZh: '测试晚餐',
          ingredients: [
            { displayNameZh: '测试米饭', grams: 100 },
            { displayNameZh: '测试鸡胸肉', grams: 100 }
          ]
        },
        {
          slot: 'snack' as const,
          recipeTemplateVersionId: 'recipe-snack',
          servingMultiplier: 1,
          displayStatus: 'complete' as const,
          dishNameZh: '测试加餐',
          ingredients: [{ displayNameZh: '测试水果', grams: 60 }]
        }
      ],
      ingredientAmounts: [
        { foodId: 'internal-rice', grams: 200 },
        { foodId: 'internal-chicken', grams: 120 },
        { foodId: 'internal-vegetable', grams: 180 },
        { foodId: 'internal-fruit', grams: 60 }
      ],
      nutritionTotals: {
        energyKcal: 1800,
        proteinG: 90,
        fatG: 50,
        carbohydrateG: 240,
        fiberG: 28,
        saturatedFatG: 10,
        addedSugarG: 5
      },
      nutritionSourceSnapshotIds: ['snapshot-1']
    };
  });
  return {
    kind: 'current_context',
    bodyProfile: null,
    goal: null,
    trainingPlan: null,
    dailyEnergyTargets: [],
    dailyNutritionTargets: [],
    inventory: null,
    mealPlan: {
      kind: 'meal_plan_version',
      id: 'meal-active',
      version: 4,
      createdAt: '2026-08-10T00:00:00.000Z',
      weekStartDate: '2026-08-17',
      bodyProfileVersionId: 'profile-1',
      goalVersionId: 'goal-1',
      trainingPlanVersionId: 'training-1',
      inventoryVersionId: 'inventory-1',
      catalogVersionId: 'catalog-1',
      generationPolicyVersion: 'weekly-meal-generation-v1',
      supersedesVersionId: null,
      readiness: 'complete',
      days
    },
    mealPlanStale: true,
    pendingMealPlanCandidate: {
      kind: 'meal_plan_version',
      id: 'meal-candidate',
      version: 5,
      createdAt: '2026-08-10T01:00:00.000Z',
      weekStartDate: '2026-08-17',
      bodyProfileVersionId: 'profile-1',
      goalVersionId: 'goal-1',
      trainingPlanVersionId: 'training-2',
      inventoryVersionId: 'inventory-1',
      catalogVersionId: 'catalog-1',
      generationPolicyVersion: 'weekly-meal-generation-v1',
      supersedesVersionId: 'meal-active',
      readiness: 'pending_confirmation',
      days
    },
    pendingMealPlanTargetDiffs: [{
      id: 'diff-internal',
      candidateMealPlanVersionId: 'meal-candidate',
      businessDate: '2026-08-18',
      previousNutritionTargetVersionId: 'target-old',
      proposedNutritionTargetVersionId: 'target-new',
      reason: 'locked_or_manually_modified',
      displayStatus: 'complete',
      previousTarget: {
        estimatedEnergyKcal: 1800,
        proteinG: 90,
        fatG: 50,
        carbohydrateG: 240,
        fiberRangeG: { minInclusive: 25, maxInclusive: 30 }
      },
      proposedTarget: {
        estimatedEnergyKcal: 1900,
        proteinG: 95,
        fatG: 52,
        carbohydrateG: 250,
        fiberRangeG: { minInclusive: 25, maxInclusive: 30 }
      },
      previousMeals: [{
        slot: 'breakfast' as const,
        dishNameZh: '测试早餐',
        ingredients: [
          { displayNameZh: '测试米饭', grams: 100 },
          { displayNameZh: '测试鸡蛋', grams: 50 }
        ]
      }],
      proposedMeals: [{
        slot: 'breakfast' as const,
        dishNameZh: '测试早餐',
        ingredients: [
          { displayNameZh: '测试米饭', grams: 100 },
          { displayNameZh: '测试鸡蛋', grams: 50 }
        ]
      }]
    }],
    selectableRecipes: [...recipes],
    selectableRecipesStatus: 'available',
    retryableRecalculationJob: null,
    latestVersions: {
      bodyProfile: 1,
      goal: 1,
      trainingPlan: 2,
      inventory: 1,
      mealPlan: 4,
      mealPlanDecision: 0,
      trainingCompletion: 0,
      recalculationJob: 0
    }
  };
}

describe('meal execution view model', () => {
  it('renders seven sorted days with Chinese slots, grams, estimated nutrients, and explicit state text', () => {
    const viewModel = buildMealExecutionViewModel(contextFixture());

    expect(viewModel.days).toHaveLength(7);
    expect(viewModel.days.map((day) => day.businessDate)).toEqual([...dates]);
    expect(viewModel.days[0]).toMatchObject({
      statusText: '可调整',
      ingredientSummaryText: '4 种食材 · 合计 560 克',
      estimatedNutritionText: '估算 1800 千卡 · 蛋白质 90 克 · 脂肪 50 克 · 碳水 240 克',
      meals: [
        {
          slot: 'breakfast',
          slotLabel: '早餐',
          dishNameZh: '测试早餐',
          ingredients: [
            { displayNameZh: '测试米饭', gramsText: '估算 100 克' },
            { displayNameZh: '测试鸡蛋', gramsText: '估算 50 克' }
          ]
        },
        {
          slot: 'lunch',
          slotLabel: '午餐',
          dishNameZh: '测试午餐',
          ingredients: [
            { displayNameZh: '测试鸡胸肉', gramsText: '估算 120 克' },
            { displayNameZh: '测试蔬菜', gramsText: '估算 180 克' }
          ]
        },
        { slot: 'dinner', slotLabel: '晚餐', dishNameZh: '测试晚餐' },
        { slot: 'snack', slotLabel: '加餐', dishNameZh: '测试加餐' }
      ]
    });
    expect(viewModel.days[1]?.statusText).toBe('已锁定');
    expect(viewModel.days[2]?.statusText).toBe('已手动修改');
    expect(JSON.stringify(viewModel)).not.toContain('internal-rice');
  });

  it('shows stale context and both explicit pending-candidate choices without exposing IDs', () => {
    const viewModel = buildMealExecutionViewModel(contextFixture());

    expect(viewModel.staleBanner).toContain('训练或营养目标已变化');
    expect(viewModel.pendingDiffs).toEqual([{
      businessDate: '2026-08-18',
      reasonText: '该日已锁定或手动修改，新餐单不会静默覆盖。',
      targetChangeText: '估算目标：能量 1800→1900 千卡（+100）；蛋白质 90→95 克（+5）；脂肪 50→52 克（+2）；碳水 240→250 克（+10）；纤维 25–30→25–30 克',
      mealChangeText: '菜品与克数保持不变：早餐 测试早餐（测试米饭 100 克、测试鸡蛋 50 克）'
    }]);
    expect(viewModel.decisionOptions).toEqual([
      { value: 'keep_existing', label: '保留当前锁定餐单' },
      { value: 'overwrite_locked', label: '确认并覆盖锁定日' }
    ]);
    expect(JSON.stringify(viewModel.pendingDiffs)).not.toMatch(/diff-internal|target-old|target-new/);
  });

  it('maps provider and infeasible failures to actionable recovery messages', () => {
    expect(mealPlanningErrorMessage('provider_unavailable')).toContain('稍后点击“重试餐单重算”');
    expect(mealPlanningErrorMessage('nutrition_constraints_infeasible')).toContain('补充可用食材后重新生成');
    expect(mealPlanningErrorMessage('nutrition_constraints_infeasible')).toContain('过敏原不会被放宽');
  });

  it('keeps persisted dish names and explains how to recover when recipes are unavailable', () => {
    const context = contextFixture();
    const viewModel = buildMealExecutionViewModel({
      ...context,
      selectableRecipes: [],
      selectableRecipesStatus: 'provider_unavailable'
    });

    expect(viewModel.days[0]?.meals[0]?.dishNameZh).toBe('测试早餐');
    expect(viewModel.recipeSelectionAvailable).toBe(false);
    expect(viewModel.recipeAvailabilityMessage).toContain('备选菜品暂不可用');
    expect(viewModel.recipeAvailabilityMessage).toContain('刷新');
  });

  it('renders legacy meal and diff snapshots as safe actionable text without exposing internal ids', () => {
    const context = contextFixture();
    const legacyContext: CurrentContext = {
      ...context,
      mealPlan: context.mealPlan === null ? null : {
        ...context.mealPlan,
        days: context.mealPlan.days.map((day) => ({
          ...day,
          meals: day.meals.map((meal) => ({
            slot: meal.slot,
            recipeTemplateVersionId: meal.recipeTemplateVersionId,
            servingMultiplier: meal.servingMultiplier,
            displayStatus: 'legacy_unavailable',
            dishNameZh: '历史餐单菜名暂不可用',
            ingredients: [],
            displayMessage: '历史餐单缺少展示快照，数值记录仍保留，可重新生成补齐。'
          }))
        }))
      },
      pendingMealPlanTargetDiffs: context.pendingMealPlanTargetDiffs.map((diff) => ({
        id: diff.id,
        candidateMealPlanVersionId: diff.candidateMealPlanVersionId,
        businessDate: diff.businessDate,
        reason: diff.reason,
        displayStatus: 'legacy_unavailable',
        displayMessage: '历史餐单差异缺少展示快照，数值记录仍保留；可保留当前餐单，或重新生成后再确认覆盖。'
      }))
    };

    const viewModel = buildMealExecutionViewModel(legacyContext);

    expect(viewModel.days[0]?.meals[0]).toMatchObject({
      dishNameZh: '历史餐单菜名暂不可用',
      ingredients: [],
      displayMessage: '历史餐单缺少展示快照，数值记录仍保留，可重新生成补齐。'
    });
    expect(viewModel.pendingDiffs[0]).toMatchObject({
      targetChangeText: '历史餐单差异缺少展示快照，数值记录仍保留；可保留当前餐单，或重新生成后再确认覆盖。',
      mealChangeText: ''
    });
    expect(JSON.stringify(viewModel)).not.toMatch(
      /recipe-breakfast|internal-rice|diff-internal|target-old|target-new/
    );
  });

  it('keeps fact success separate when meal recalculation can be retried', () => {
    const feedback = buildCompletionFeedback({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: {
          kind: 'training_completion_event',
          id: 'completion-1',
          version: 1,
          trainingPlanVersionId: 'training-1',
          businessDate: '2026-08-19',
          completedDurationMinutes: 30,
          occurredAt: '2026-08-19T04:00:00.000Z'
        },
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        recalculationJob: {
          kind: 'recalculation_job',
          id: 'retry-job-private',
          triggerEventId: 'completion-1',
          triggerType: 'training_completion',
          affectedDates: ['2026-08-19'],
          status: 'failed_retryable',
          createdAt: '2026-08-19T04:00:00.000Z',
          completedAt: null,
          candidateMealPlanVersionId: null,
          activatedMealPlanVersionId: null,
          failureCode: 'provider_unavailable'
        },
        candidateMealPlan: null,
        targetDiffs: [],
        recalculationStatus: 'failed_retryable'
      }
    });

    expect(feedback).toEqual({
      factMessage: '训练完成情况已保存。',
      mealMessage: '餐单重算暂未完成，训练事实不受影响。请稍后重试。',
      retryJobId: 'retry-job-private',
      needsStatusRefresh: false
    });
  });

  it('offers a refresh-status recovery when a retryable response has no job identifier', () => {
    const feedback = buildCompletionFeedback({
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: {
          kind: 'training_completion_event',
          id: 'completion-2',
          version: 2,
          trainingPlanVersionId: 'training-1',
          businessDate: '2026-08-20',
          completedDurationMinutes: 20,
          occurredAt: '2026-08-20T04:00:00.000Z'
        },
        dailyEnergyTargets: [],
        dailyNutritionTargets: [],
        recalculationJob: null,
        candidateMealPlan: null,
        targetDiffs: [],
        recalculationStatus: 'failed_retryable'
      }
    });

    expect(feedback).toEqual({
      factMessage: '训练完成情况已保存。',
      mealMessage: '餐单重算暂未完成，训练事实不受影响。请刷新状态后重试。',
      retryJobId: '',
      needsStatusRefresh: true
    });
  });
});
