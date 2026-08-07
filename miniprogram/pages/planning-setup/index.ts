import type { PlanningApiResponse } from '@fitness/contracts';
import { planningApiClient } from '../../services/planning-api';
import {
  buildPlanningSetupRequests,
  type LegacyPlanningSetupFormInput
} from './form';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type CurrentContext = Extract<SuccessData, { kind: 'current_context' }>;
type DailyTarget = Extract<SuccessData, { kind: 'training_plan_saved' }>['dailyEnergyTargets'][number];

interface TextValueEvent { readonly detail: { readonly value: string } }
interface SwitchValueEvent { readonly detail: { readonly value: boolean } }

interface DisplayTarget {
  readonly businessDate: string;
  readonly energyText: string;
}

interface PageData extends LegacyPlanningSetupFormInput {
  readonly activityLabels: readonly string[];
  readonly activityValues: readonly string[];
  activityIndex: number;
  readonly goalLabels: readonly string[];
  readonly goalValues: readonly string[];
  goalIndex: number;
  hasTraining: boolean;
  loading: boolean;
  errorMessage: string;
  successMessage: string;
  displayTargets: readonly DisplayTarget[];
}

interface PageActions {
  onAgeInput(event: TextValueEvent): void;
  onHeightInput(event: TextValueEvent): void;
  onWeightInput(event: TextValueEvent): void;
  onTargetWeightInput(event: TextValueEvent): void;
  onAllergensInput(event: TextValueEvent): void;
  onAvoidFoodsInput(event: TextValueEvent): void;
  onDietPreferencesInput(event: TextValueEvent): void;
  onDurationInput(event: TextValueEvent): void;
  onSexChange(event: TextValueEvent): void;
  onActivityChange(event: TextValueEvent): void;
  onGoalChange(event: TextValueEvent): void;
  onHealthScopeChange(event: SwitchValueEvent): void;
  onHasTrainingChange(event: SwitchValueEvent): void;
  onEffectiveDateChange(event: TextValueEvent): void;
  onTargetDateChange(event: TextValueEvent): void;
  onWeekStartDateChange(event: TextValueEvent): void;
  onTrainingDateChange(event: TextValueEvent): void;
  onSubmit(): Promise<void>;
}

function pickerIndex(value: string, length: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : 0;
}

function idempotencyKey(prefix: string): string {
  const randomPart = Math.random().toString(36).slice(2);
  return `${prefix}-${String(Date.now())}-${randomPart}`;
}

function errorMessage(response: PlanningApiResponse): string | undefined {
  return response.success ? undefined : response.error.message;
}

function currentContext(response: PlanningApiResponse): CurrentContext | undefined {
  return response.success && response.data.kind === 'current_context'
    ? response.data
    : undefined;
}

function targetText(target: DailyTarget): string {
  if (target.energy.kind === 'unsupported') return '暂不支持个性化能量目标';
  return `${String(target.energy.targetEnergyKcal)} kcal（估算）`;
}

Page<PageData, PageActions>({
  data: {
    ageYears: '',
    sexCode: '',
    heightCm: '',
    weightKg: '',
    healthScopeConfirmed: false,
    activity: '',
    activityLabels: ['请选择', '轻：久坐工作，少量通勤家务', '中：较多走动或体力家务', '重：持续体力工作'],
    activityValues: ['', 'light', 'moderate', 'heavy'],
    activityIndex: 0,
    allergens: '',
    avoidFoods: '',
    dietPreferences: '',
    goal: '',
    goalLabels: ['请选择', '维持', '减脂', '增肌'],
    goalValues: ['', 'maintain', 'fat_loss', 'muscle_gain'],
    goalIndex: 0,
    targetWeightKg: '',
    effectiveDate: '',
    targetDate: '',
    weekStartDate: '',
    hasTraining: false,
    trainingDate: '',
    durationMinutes: '',
    loading: false,
    errorMessage: '',
    successMessage: '',
    displayTargets: []
  },
  onAgeInput(event: TextValueEvent) { this.setData({ ageYears: event.detail.value }); },
  onHeightInput(event: TextValueEvent) { this.setData({ heightCm: event.detail.value }); },
  onWeightInput(event: TextValueEvent) { this.setData({ weightKg: event.detail.value }); },
  onTargetWeightInput(event: TextValueEvent) { this.setData({ targetWeightKg: event.detail.value }); },
  onAllergensInput(event: TextValueEvent) { this.setData({ allergens: event.detail.value }); },
  onAvoidFoodsInput(event: TextValueEvent) { this.setData({ avoidFoods: event.detail.value }); },
  onDietPreferencesInput(event: TextValueEvent) { this.setData({ dietPreferences: event.detail.value }); },
  onDurationInput(event: TextValueEvent) { this.setData({ durationMinutes: event.detail.value }); },
  onSexChange(event: TextValueEvent) {
    this.setData({ sexCode: event.detail.value === '0' || event.detail.value === '1' ? event.detail.value : '' });
  },
  onActivityChange(event: TextValueEvent) {
    const activityIndex = pickerIndex(event.detail.value, this.data.activityValues.length);
    this.setData({
      activityIndex,
      activity: this.data.activityValues[activityIndex] ?? ''
    });
  },
  onGoalChange(event: TextValueEvent) {
    const goalIndex = pickerIndex(event.detail.value, this.data.goalValues.length);
    this.setData({ goalIndex, goal: this.data.goalValues[goalIndex] ?? '' });
  },
  onHealthScopeChange(event: SwitchValueEvent) {
    this.setData({ healthScopeConfirmed: event.detail.value });
  },
  onHasTrainingChange(event: SwitchValueEvent) {
    this.setData({
      hasTraining: event.detail.value,
      ...(event.detail.value ? {} : { trainingDate: '', durationMinutes: '' })
    });
  },
  onEffectiveDateChange(event: TextValueEvent) { this.setData({ effectiveDate: event.detail.value }); },
  onTargetDateChange(event: TextValueEvent) { this.setData({ targetDate: event.detail.value }); },
  onWeekStartDateChange(event: TextValueEvent) { this.setData({ weekStartDate: event.detail.value }); },
  onTrainingDateChange(event: TextValueEvent) { this.setData({ trainingDate: event.detail.value }); },
  async onSubmit() {
    this.setData({ loading: true, errorMessage: '', successMessage: '', displayTargets: [] });
    try {
      const contextResponse = await planningApiClient.call({ action: 'getCurrentContext' });
      const context = currentContext(contextResponse);
      if (context === undefined) {
        this.setData({ errorMessage: errorMessage(contextResponse) ?? '无法读取当前规划版本。' });
        return;
      }
      const built = buildPlanningSetupRequests({
        ...this.data,
        trainingDate: this.data.hasTraining ? this.data.trainingDate : '',
        durationMinutes: this.data.hasTraining ? this.data.durationMinutes : ''
      }, {
        bodyProfile: context.bodyProfile?.version ?? 0,
        goal: context.goal?.version ?? 0,
        trainingPlan: context.trainingPlan?.version ?? 0
      }, {
        bodyProfile: idempotencyKey('profile'),
        goal: idempotencyKey('goal'),
        trainingPlan: idempotencyKey('training')
      });
      if (built.kind === 'invalid') {
        this.setData({ errorMessage: built.message });
        return;
      }

      const profileResponse = await planningApiClient.call(built.bodyProfile);
      if (!profileResponse.success) {
        this.setData({ errorMessage: profileResponse.error.message });
        return;
      }
      const goalResponse = await planningApiClient.call(built.goal);
      if (!goalResponse.success) {
        this.setData({ errorMessage: goalResponse.error.message });
        return;
      }
      const trainingResponse = await planningApiClient.call(built.trainingPlan);
      if (!trainingResponse.success || trainingResponse.data.kind !== 'training_plan_saved') {
        this.setData({ errorMessage: errorMessage(trainingResponse) ?? '训练计划保存失败。' });
        return;
      }
      this.setData({
        successMessage: '档案、目标和一周训练计划已保存为新版本。',
        displayTargets: trainingResponse.data.dailyEnergyTargets.map((target) => ({
          businessDate: target.businessDate,
          energyText: targetText(target)
        }))
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: error instanceof Error ? error.message : '规划服务暂时不可用。' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
