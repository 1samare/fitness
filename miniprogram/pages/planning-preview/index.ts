import type { PlanningApiResponse } from '@fitness/contracts';
import { planningApiClient } from '../../services/planning-api';
import { submitPlanningForm, type PlanningFormInput } from './form';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type SupportedResult = Extract<SuccessData, { kind: 'supported' }>;
type UnsupportedResult = Extract<SuccessData, { kind: 'unsupported' }>;

interface TextValueEvent { readonly detail: { readonly value: string } }
interface SwitchValueEvent { readonly detail: { readonly value: boolean } }

interface PageData extends PlanningFormInput {
  activityLabels: readonly string[];
  goalLabels: readonly string[];
  trainingLabels: readonly string[];
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
    ageYears: '',
    heightCm: '',
    weightKg: '',
    durationMinutes: '',
    sexCode: '',
    activityIndex: 0,
    activityLabels: ['请选择', '轻：久坐工作，少量通勤家务', '中：较多走动或体力家务', '重：持续体力工作'],
    goalIndex: 0,
    goalLabels: ['请选择', '维持', '减脂', '增肌'],
    trainingIndex: 0,
    trainingLabels: ['请选择', '无计划训练', '多动作抗阻训练（会话 02054）'],
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
  onSexChange(event) {
    const sexCode = event.detail.value === '0' || event.detail.value === '1'
      ? event.detail.value
      : '';
    this.setData({ sexCode });
  },
  onActivityChange(event) {
    this.setData({ activityIndex: pickerIndex(event.detail.value, this.data.activityLabels.length) });
  },
  onGoalChange(event) {
    this.setData({ goalIndex: pickerIndex(event.detail.value, this.data.goalLabels.length) });
  },
  onTrainingChange(event) {
    this.setData({ trainingIndex: pickerIndex(event.detail.value, this.data.trainingLabels.length) });
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
    try {
      const submission = await submitPlanningForm(this.data, planningApiClient);
      if (submission.kind === 'invalid') {
        this.setData({ errorMessage: submission.message });
        return;
      }
      const response = submission.response;
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
