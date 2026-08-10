import type { PlanningApiResponse } from '@fitness/contracts';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type SetupCompleted = Extract<SuccessData, { kind: 'planning_setup_completed' }>;
type DailyNutritionTarget = SetupCompleted['dailyNutritionTargets'][number];

export function nutritionTargetText(target: DailyNutritionTarget): string {
  if (target.energy.kind === 'unsupported' || target.nutrition === null) {
    return '暂不支持个性化能量与营养目标';
  }
  if (target.nutrition.kind === 'infeasible') {
    return `${String(target.nutrition.targetEnergyKcal)} kcal（估算） · 营养约束无可行解`;
  }
  const nutrition = target.nutrition;
  return [
    `${String(nutrition.targetEnergyKcal)} kcal（估算）`,
    `蛋白质 ${String(nutrition.proteinG)} g`,
    `脂肪 ${String(nutrition.fatG)} g`,
    `碳水 ${String(nutrition.carbohydrateG)} g`,
    `纤维 ${String(nutrition.fiberRangeG.minInclusive)}–${String(nutrition.fiberRangeG.maxInclusive)} g`,
    `饱和脂肪 <${String(nutrition.saturatedFatMaxExclusiveG)} g`,
    `添加糖 <${String(nutrition.addedSugarMaxExclusiveG)} g`
  ].join(' · ');
}
