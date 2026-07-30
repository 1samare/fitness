import type { PlanningApiResponse, PlanningApiRequest } from '@fitness/contracts';
import { planningApiClient } from '../../services/planning-api';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type SupportedResult = Extract<SuccessData, { kind: 'supported' }>;
type UnsupportedResult = Extract<SuccessData, { kind: 'unsupported' }>;

interface TextValueEvent { readonly detail: { readonly value: string } }
interface SwitchValueEvent { readonly detail: { readonly value: boolean } }

const activityValues = ['light', 'moderate', 'heavy'] as const;
const goalValues = ['maintain', 'fat_loss', 'muscle_gain'] as const;

interface PageData {
  ageYears: string;
  heightCm: string;
  weightKg: string;
  durationMinutes: string;
  sexCode: '0' | '1';
  activityIndex: number;
  activityLabels: readonly string[];
  goalIndex: number;
  goalLabels: readonly string[];
  trainingIndex: number;
  trainingLabels: readonly string[];
  healthScopeConfirmed: boolean;
  loading: boolean;
  supportedResult: SupportedResult | null;
  supportedSourceText: string;
  unsupportedResult: UnsupportedResult | null;
  unsupportedReasonText: string;
  errorMessage: string;
}

interface PageActions {
  onAgeInput(event: TextValueEvent): void;
  onHeightInput(event: TextValueEvent): void;
  onWeightInput(event: TextValueEvent): void;
  onDurationInput(event: TextValueEvent): void;
  onSexChange(event: TextValueEvent): void;
  onActivityChange(event: TextValueEvent): void;
  onGoalChange(event: TextValueEvent): void;
  onTrainingChange(event: TextValueEvent): void;
  onHealthScopeChange(event: SwitchValueEvent): void;
  onSubmit(): Promise<void>;
}

function reasonText(reasons: readonly string[]): string {
  return reasons.map((reason) => {
    if (reason === 'age_out_of_range') return '年龄不在 18–45 岁范围内';
    if (reason === 'bmi_out_of_range') return 'BMI 不在 18.5–<24.0 范围内';
    if (reason === 'health_scope_not_confirmed') return '尚未完成健康适用范围确认';
    return '存在不支持自动个性化能量的条件';
  }).join('；');
}

function pickerIndex(value: string, length: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : 0;
}

Page<PageData, PageActions>({
  data: {
    ageYears: '30',
    heightCm: '175',
    weightKg: '70',
    durationMinutes: '60',
    sexCode: '0',
    activityIndex: 0,
    activityLabels: ['轻：久坐工作，少量通勤家务', '中：较多走动或体力家务', '重：持续体力工作'],
    goalIndex: 0,
    goalLabels: ['维持', '减脂', '增肌'],
    trainingIndex: 0,
    trainingLabels: ['无计划训练', '多动作抗阻训练（会话 02054）'],
    healthScopeConfirmed: false,
    loading: false,
    supportedResult: null,
    supportedSourceText: '',
    unsupportedResult: null,
    unsupportedReasonText: '',
    errorMessage: ''
  },
  onAgeInput(event) { this.setData({ ageYears: event.detail.value }); },
  onHeightInput(event) { this.setData({ heightCm: event.detail.value }); },
  onWeightInput(event) { this.setData({ weightKg: event.detail.value }); },
  onDurationInput(event) { this.setData({ durationMinutes: event.detail.value }); },
  onSexChange(event) { this.setData({ sexCode: event.detail.value === '1' ? '1' : '0' }); },
  onActivityChange(event) {
    this.setData({ activityIndex: pickerIndex(event.detail.value, activityValues.length) });
  },
  onGoalChange(event) {
    this.setData({ goalIndex: pickerIndex(event.detail.value, goalValues.length) });
  },
  onTrainingChange(event) {
    this.setData({ trainingIndex: pickerIndex(event.detail.value, 2) });
  },
  onHealthScopeChange(event) { this.setData({ healthScopeConfirmed: event.detail.value }); },
  async onSubmit() {
    this.setData({
      loading: true,
      supportedResult: null,
      supportedSourceText: '',
      unsupportedResult: null,
      unsupportedReasonText: '',
      errorMessage: ''
    });
    const activity = activityValues[this.data.activityIndex] ?? 'light';
    const goal = goalValues[this.data.goalIndex] ?? 'maintain';
    const training = this.data.trainingIndex === 1
      ? { sessionCode: '02054', durationMinutes: Number(this.data.durationMinutes) }
      : undefined;
    const request: PlanningApiRequest = {
      action: 'previewDailyEnergy',
      payload: {
        ageYears: Number(this.data.ageYears),
        sexCode: this.data.sexCode === '0' ? 0 : 1,
        heightCm: Number(this.data.heightCm),
        weightKg: Number(this.data.weightKg),
        healthScopeConfirmed: this.data.healthScopeConfirmed,
        nonTrainingActivity: activity,
        goal,
        ...(training === undefined ? {} : { training })
      }
    };
    try {
      const response = await planningApiClient.call(request);
      if (!response.success) {
        this.setData({ errorMessage: response.error.message });
      } else if (response.data.kind === 'supported') {
        this.setData({
          supportedResult: response.data,
          supportedSourceText: response.data.policy.sourceIds.join('、')
        });
      } else if (response.data.kind === 'unsupported') {
        this.setData({
          unsupportedResult: response.data,
          unsupportedReasonText: reasonText(response.data.reasons)
        });
      } else {
        this.setData({ errorMessage: '规划服务返回了非预期结果。' });
      }
    } catch (error: unknown) {
      this.setData({ errorMessage: error instanceof Error ? error.message : '本地规划服务暂时不可用。' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
