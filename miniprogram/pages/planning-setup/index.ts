import type { PlanningApiResponse } from '@fitness/contracts';
import { REVIEWED_MET_DATASET } from '@fitness/met-sessions';
import { planningApiClient } from '../../services/planning-api';
import {
  buildPlanningSetupPayload,
  buildTrainingDayRows,
  type PlanningSetupFormInput,
  type TrainingDayFormInput
} from './form';
import {
  parsePendingPlanningSetup,
  pendingPlanningSetupMatches,
  selectPlanningSetupCommand,
  type PendingPlanningSetup
} from './pending-command';
import { nutritionTargetText } from './target-display';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type CurrentContext = Extract<SuccessData, { kind: 'current_context' }>;

interface TextValueEvent { readonly detail: { readonly value: string } }
interface SwitchValueEvent { readonly detail: { readonly value: boolean } }
interface IndexedEvent { readonly currentTarget: { readonly dataset: { readonly index?: unknown } } }
interface IndexedTextValueEvent extends TextValueEvent, IndexedEvent {}
interface IndexedSwitchValueEvent extends SwitchValueEvent, IndexedEvent {}

interface TrainingDayPageInput extends TrainingDayFormInput {
  readonly sessionIndex: number;
  readonly disabledReason: string;
}

interface DisplayTarget {
  readonly businessDate: string;
  readonly summaryText: string;
}

interface PageData extends PlanningSetupFormInput {
  readonly activityLabels: readonly string[];
  readonly activityValues: readonly string[];
  activityIndex: number;
  readonly goalLabels: readonly string[];
  readonly goalValues: readonly string[];
  goalIndex: number;
  readonly sessionLabels: readonly string[];
  readonly trainingDays: readonly TrainingDayPageInput[];
  businessToday: string;
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
  onSexChange(event: TextValueEvent): void;
  onActivityChange(event: TextValueEvent): void;
  onGoalChange(event: TextValueEvent): void;
  onHealthScopeChange(event: SwitchValueEvent): void;
  onEffectiveDateChange(event: TextValueEvent): void;
  onTargetDateChange(event: TextValueEvent): void;
  onWeekStartDateChange(event: TextValueEvent): void;
  onTrainingEnabledChange(event: IndexedSwitchValueEvent): void;
  onTrainingSessionChange(event: IndexedTextValueEvent): void;
  onTrainingDurationInput(event: IndexedTextValueEvent): void;
  onOpenMealExecution(): void;
  onSubmit(): Promise<void>;
}

const pendingStorageKey = 'fitness.pendingPlanningSetup.v1';
const sessionLabels = REVIEWED_MET_DATASET.sessions.map((session) => session.displayNameZh);
const sessionCodes = REVIEWED_MET_DATASET.sessions.map((session) => session.code);

function pickerIndex(value: string, length: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : 0;
}

function eventIndex(event: IndexedEvent, length: number): number | undefined {
  const parsed = Number(event.currentTarget.dataset.index);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : undefined;
}

function idempotencyKey(): string {
  const randomPart = Math.random().toString(36).slice(2);
  return `planning-setup-${String(Date.now())}-${randomPart}`;
}

function shanghaiBusinessDate(now = new Date()): string {
  const utcEight = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utcEight.toISOString().slice(0, 10);
}

function errorMessage(response: PlanningApiResponse): string | undefined {
  return response.success ? undefined : response.error.message;
}

function currentContext(response: PlanningApiResponse): CurrentContext | undefined {
  return response.success && response.data.kind === 'current_context'
    ? response.data
    : undefined;
}

function decorateTrainingDays(input: {
  readonly weekStartDate: string;
  readonly businessToday: string;
  readonly effectiveDate: string;
  readonly targetDate: string;
  readonly previous: readonly TrainingDayPageInput[];
}): TrainingDayPageInput[] {
  if (
    input.weekStartDate.length === 0
    || input.effectiveDate.length === 0
    || input.targetDate.length === 0
  ) {
    return [];
  }
  let rows: TrainingDayFormInput[];
  try {
    rows = buildTrainingDayRows(
      input.weekStartDate,
      input.businessToday,
      input.effectiveDate,
      input.targetDate
    );
  } catch {
    return [];
  }
  const previousByDate = new Map(input.previous.map((row) => [row.businessDate, row]));
  return rows.map((row) => {
    const previous = previousByDate.get(row.businessDate);
    const sessionCode = previous?.sessionCode ?? '';
    const sessionIndex = sessionCodes.findIndex((code) => code === sessionCode);
    return {
      ...row,
      enabled: row.disabled ? false : (previous?.enabled ?? false),
      sessionCode,
      durationMinutes: previous?.durationMinutes ?? '',
      sessionIndex: sessionIndex < 0 ? 0 : sessionIndex,
      disabledReason: !row.disabled
        ? ''
        : row.businessDate < input.businessToday
          ? '过去日期不可改'
          : '目标周期外'
    };
  });
}

function refreshTrainingDays(
  data: PageData,
  dates: Partial<Pick<PageData, 'effectiveDate' | 'targetDate' | 'weekStartDate'>>
): TrainingDayPageInput[] {
  return decorateTrainingDays({
    weekStartDate: dates.weekStartDate ?? data.weekStartDate,
    businessToday: data.businessToday,
    effectiveDate: dates.effectiveDate ?? data.effectiveDate,
    targetDate: dates.targetDate ?? data.targetDate,
    previous: data.trainingDays
  });
}

function replaceTrainingDay(
  rows: readonly TrainingDayPageInput[],
  index: number,
  update: (row: TrainingDayPageInput) => TrainingDayPageInput
): TrainingDayPageInput[] {
  return rows.map((row, rowIndex) => rowIndex === index ? update(row) : row);
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
    sessionLabels,
    trainingDays: [],
    businessToday: shanghaiBusinessDate(),
    loading: false,
    errorMessage: '',
    successMessage: '',
    displayTargets: []
  },
  onAgeInput(event) { this.setData({ ageYears: event.detail.value }); },
  onHeightInput(event) { this.setData({ heightCm: event.detail.value }); },
  onWeightInput(event) { this.setData({ weightKg: event.detail.value }); },
  onTargetWeightInput(event) { this.setData({ targetWeightKg: event.detail.value }); },
  onAllergensInput(event) { this.setData({ allergens: event.detail.value }); },
  onAvoidFoodsInput(event) { this.setData({ avoidFoods: event.detail.value }); },
  onDietPreferencesInput(event) { this.setData({ dietPreferences: event.detail.value }); },
  onSexChange(event) {
    this.setData({
      sexCode: event.detail.value === '0' || event.detail.value === '1'
        ? event.detail.value
        : ''
    });
  },
  onActivityChange(event) {
    const activityIndex = pickerIndex(event.detail.value, this.data.activityValues.length);
    this.setData({
      activityIndex,
      activity: this.data.activityValues[activityIndex] ?? ''
    });
  },
  onGoalChange(event) {
    const goalIndex = pickerIndex(event.detail.value, this.data.goalValues.length);
    this.setData({ goalIndex, goal: this.data.goalValues[goalIndex] ?? '' });
  },
  onHealthScopeChange(event) {
    this.setData({ healthScopeConfirmed: event.detail.value });
  },
  onEffectiveDateChange(event) {
    const effectiveDate = event.detail.value;
    this.setData({
      effectiveDate,
      trainingDays: refreshTrainingDays(this.data, { effectiveDate })
    });
  },
  onTargetDateChange(event) {
    const targetDate = event.detail.value;
    this.setData({
      targetDate,
      trainingDays: refreshTrainingDays(this.data, { targetDate })
    });
  },
  onWeekStartDateChange(event) {
    const weekStartDate = event.detail.value;
    this.setData({
      weekStartDate,
      trainingDays: refreshTrainingDays(this.data, { weekStartDate })
    });
  },
  onTrainingEnabledChange(event) {
    const index = eventIndex(event, this.data.trainingDays.length);
    if (index === undefined) return;
    this.setData({
      trainingDays: replaceTrainingDay(this.data.trainingDays, index, (row) => {
        if (row.disabled) return row;
        const sessionCode = row.sessionCode || sessionCodes[0];
        return {
          ...row,
          enabled: event.detail.value,
          sessionCode: sessionCode ?? '',
          sessionIndex: sessionCode === undefined
            ? 0
            : Math.max(0, sessionCodes.findIndex((code) => code === sessionCode))
        };
      })
    });
  },
  onTrainingSessionChange(event) {
    const index = eventIndex(event, this.data.trainingDays.length);
    if (index === undefined) return;
    const sessionIndex = pickerIndex(event.detail.value, sessionCodes.length);
    this.setData({
      trainingDays: replaceTrainingDay(this.data.trainingDays, index, (row) => ({
        ...row,
        sessionIndex,
        sessionCode: sessionCodes[sessionIndex] ?? ''
      }))
    });
  },
  onTrainingDurationInput(event) {
    const index = eventIndex(event, this.data.trainingDays.length);
    if (index === undefined) return;
    this.setData({
      trainingDays: replaceTrainingDay(this.data.trainingDays, index, (row) => ({
        ...row,
        durationMinutes: event.detail.value
      }))
    });
  },
  onOpenMealExecution() {
    void wx.navigateTo({ url: '/pages/meal-execution/index' });
  },
  async onSubmit() {
    this.setData({ loading: true, errorMessage: '', successMessage: '', displayTargets: [] });
    try {
      const built = buildPlanningSetupPayload(this.data);
      if (built.kind === 'invalid') {
        this.setData({ errorMessage: built.message });
        return;
      }

      const storedValue: unknown = wx.getStorageSync(pendingStorageKey);
      const storedPending = parsePendingPlanningSetup(storedValue);
      let pending: PendingPlanningSetup;
      if (
        storedPending !== undefined
        && pendingPlanningSetupMatches(storedPending, built.payload)
      ) {
        pending = storedPending;
      } else {
        const contextResponse = await planningApiClient.call({ action: 'getCurrentContext' });
        const context = currentContext(contextResponse);
        if (context === undefined) {
          this.setData({
            errorMessage: errorMessage(contextResponse) ?? '无法读取当前规划版本，请稍后重试。'
          });
          return;
        }
        pending = selectPlanningSetupCommand({
          payload: built.payload,
          latestVersions: context.latestVersions,
          pending: storedPending,
          nextKey: idempotencyKey
        }).pending;
        wx.setStorageSync(pendingStorageKey, pending);
      }

      const response = await planningApiClient.call(pending.request);
      if (!response.success || response.data.kind !== 'planning_setup_completed') {
        this.setData({
          errorMessage: errorMessage(response) ?? '规划保存未确认，请保留当前表单并重试。'
        });
        return;
      }
      wx.removeStorageSync(pendingStorageKey);
      this.setData({
        successMessage: '档案、目标、训练计划与每日能量/营养目标已原子保存。',
        displayTargets: response.data.dailyNutritionTargets.map((target) => ({
          businessDate: target.businessDate,
          summaryText: nutritionTargetText(target)
        }))
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : '规划服务暂时不可用。';
      this.setData({ errorMessage: `${reason} 已保留待提交请求，请点击保存重试。` });
    } finally {
      this.setData({ loading: false });
    }
  }
});
