import type { PlanningApiResponse } from '@fitness/contracts';
import { planningApiClient } from '../../services/planning-api';
import {
  buildCandidateDecisionRequest,
  buildCompletionRequest,
  buildGenerateMealPlanRequest,
  buildInventoryRequest,
  buildLockRequest,
  buildRecipeEditRequest,
  buildResolveFoodNameRequest,
  buildRetryRequest,
  type CandidateDecision,
  type InventoryRowInput,
  type SelectableRecipeInput
} from './form';
import {
  buildCompletionFeedback,
  buildMealExecutionViewModel,
  mealPlanningErrorMessage,
  type CurrentContext,
  type MealDayDisplay
} from './view-model';
import {
  parsePendingMealCommand,
  pendingMealCommandStorageKey,
  selectPendingMealCommand,
  type MealWriteRequest
} from './pending-command';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type LatestVersions = CurrentContext['latestVersions'];

interface InventoryRow extends InventoryRowInput {
  readonly key: string;
  readonly resolutionToken: number;
  readonly resolutionStatus: 'idle' | 'resolving' | 'resolved' | 'error';
  readonly resolutionMessage: string;
}

interface MealDayPageDisplay extends MealDayDisplay {
  readonly editable: boolean;
}

interface PageData {
  inventoryRows: InventoryRow[];
  canSaveInventory: boolean;
  generationWeekStart: string;
  mealDays: MealDayPageDisplay[];
  selectableRecipes: SelectableRecipeInput[];
  recipeSelectionAvailable: boolean;
  recipeAvailabilityMessage: string;
  staleBanner: string;
  pendingDiffs: ReturnType<typeof buildMealExecutionViewModel>['pendingDiffs'];
  decisionOptions: readonly { readonly value: CandidateDecision; readonly label: string }[];
  selectedDecision: CandidateDecision;
  pendingCandidateId: string;
  retryJobId: string;
  needsRecalculationStatusRefresh: boolean;
  completionDate: string;
  completedDurationMinutes: string;
  businessToday: string;
  latestVersions: LatestVersions;
  contextLoaded: boolean;
  loadingContext: boolean;
  savingInventory: boolean;
  generatingMeal: boolean;
  updatingMeal: boolean;
  decidingCandidate: boolean;
  savingFact: boolean;
  recalculatingMeal: boolean;
  contextMessage: string;
  actionMessage: string;
  formError: string;
  factMessage: string;
  mealMessage: string;
  generationMessage: string;
}

interface TextValueEvent { readonly detail: { readonly value: string } }
interface SwitchValueEvent { readonly detail: { readonly value: boolean } }
interface IndexedEvent { readonly currentTarget: { readonly dataset: { readonly index?: unknown } } }
interface IndexedTextValueEvent extends TextValueEvent, IndexedEvent {}
interface IndexedSwitchValueEvent extends SwitchValueEvent, IndexedEvent {}
interface RecipePickerEvent extends TextValueEvent {
  readonly currentTarget: {
    readonly dataset: { readonly dayIndex?: unknown; readonly mealIndex?: unknown };
  };
}

interface PageActions {
  onLoad(): Promise<void>;
  refreshContext(): Promise<void>;
  onInventoryNameInput(event: IndexedTextValueEvent): void;
  onInventoryGramsInput(event: IndexedTextValueEvent): void;
  onAddInventoryRow(): void;
  onRemoveInventoryRow(event: IndexedEvent): void;
  onResolveInventoryRow(event: IndexedEvent): Promise<void>;
  onGenerationWeekChange(event: TextValueEvent): void;
  onSaveInventoryAndGenerate(): Promise<void>;
  onLockChange(event: IndexedSwitchValueEvent): Promise<void>;
  onRecipeChange(event: RecipePickerEvent): Promise<void>;
  onCandidateDecisionChange(event: TextValueEvent): void;
  onConfirmCandidateDecision(): Promise<void>;
  onCompletionDateChange(event: TextValueEvent): void;
  onCompletionMinutesInput(event: TextValueEvent): void;
  onRecordCompletion(): Promise<void>;
  onRetryRecalculation(): Promise<void>;
}

const emptyVersions: LatestVersions = {
  bodyProfile: 0,
  goal: 0,
  trainingPlan: 0,
  inventory: 0,
  mealPlan: 0,
  mealPlanDecision: 0,
  trainingCompletion: 0,
  recalculationJob: 0
};

let inventoryRowSequence = 0;

function nextInventoryRowKey(): string {
  inventoryRowSequence += 1;
  return `inventory-row-${String(inventoryRowSequence)}`;
}

function shanghaiBusinessDate(now = new Date()): string {
  const utcEight = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utcEight.toISOString().slice(0, 10);
}

function idempotencyKey(operation: string): string {
  const randomPart = Math.random().toString(36).slice(2);
  return `${operation}-${String(Date.now())}-${randomPart}`;
}

function eventIndex(value: unknown, length: number): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : undefined;
}

function replaceRow(
  rows: readonly InventoryRow[],
  index: number,
  update: (row: InventoryRow) => InventoryRow
): InventoryRow[] {
  return rows.map((row, rowIndex) => rowIndex === index ? update(row) : row);
}

function rowsResolved(rows: readonly InventoryRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.resolutionStatus === 'resolved');
}

function currentContext(response: PlanningApiResponse): CurrentContext | undefined {
  return response.success && response.data.kind === 'current_context'
    ? response.data
    : undefined;
}

function responseError(response: PlanningApiResponse): string {
  return response.success
    ? '规划服务返回了不匹配的结果，请刷新后重试。'
    : mealPlanningErrorMessage(response.error.code);
}

async function callPendingWrite(
  request: MealWriteRequest,
  confirmedKind: SuccessData['kind'],
  nextKey: () => string
): Promise<PlanningApiResponse> {
  const storageKey = pendingMealCommandStorageKey(request.action);
  const stored = parsePendingMealCommand(wx.getStorageSync(storageKey));
  const selected = selectPendingMealCommand({ request, pending: stored, nextKey });
  if (!selected.reused) wx.setStorageSync(storageKey, selected.pending);
  const response = await planningApiClient.call(selected.pending.request);
  if (response.success && response.data.kind === confirmedKind) wx.removeStorageSync(storageKey);
  return response;
}

Page<PageData, PageActions>({
  data: {
    inventoryRows: [{
      key: nextInventoryRowKey(),
      resolutionToken: 0,
      name: '',
      availableGrams: '',
      resolutionStatus: 'idle',
      resolutionMessage: ''
    }],
    canSaveInventory: false,
    generationWeekStart: '',
    mealDays: [],
    selectableRecipes: [],
    recipeSelectionAvailable: false,
    recipeAvailabilityMessage: '',
    staleBanner: '',
    pendingDiffs: [],
    decisionOptions: [],
    selectedDecision: 'keep_existing',
    pendingCandidateId: '',
    retryJobId: '',
    needsRecalculationStatusRefresh: false,
    completionDate: shanghaiBusinessDate(),
    completedDurationMinutes: '',
    businessToday: shanghaiBusinessDate(),
    latestVersions: emptyVersions,
    contextLoaded: false,
    loadingContext: false,
    savingInventory: false,
    generatingMeal: false,
    updatingMeal: false,
    decidingCandidate: false,
    savingFact: false,
    recalculatingMeal: false,
    contextMessage: '',
    actionMessage: '',
    formError: '',
    factMessage: '',
    mealMessage: '',
    generationMessage: ''
  },

  async onLoad() {
    await this.refreshContext();
  },

  async refreshContext() {
    if (this.data.loadingContext) return;
    const hadRetryableJob = this.data.retryJobId.length > 0;
    this.setData({ loadingContext: true, contextMessage: '' });
    try {
      const response = await planningApiClient.call({ action: 'getCurrentContext' });
      const context = currentContext(response);
      if (context === undefined) {
        this.setData({ contextMessage: responseError(response) });
        return;
      }
      const viewModel = buildMealExecutionViewModel(context);
      const weekStartDate = context.trainingPlan?.payload.weekStartDate
        ?? this.data.generationWeekStart;
      this.setData({
        contextLoaded: true,
        latestVersions: context.latestVersions,
        generationWeekStart: weekStartDate,
        mealDays: viewModel.days.map((day) => ({
          ...day,
          editable: day.businessDate > this.data.businessToday
        })),
        selectableRecipes: context.selectableRecipes.map((recipe) => ({ ...recipe })),
        recipeSelectionAvailable: viewModel.recipeSelectionAvailable,
        recipeAvailabilityMessage: viewModel.recipeAvailabilityMessage,
        staleBanner: viewModel.staleBanner,
        pendingDiffs: viewModel.pendingDiffs,
        decisionOptions: viewModel.decisionOptions,
        pendingCandidateId: context.pendingMealPlanCandidate?.id ?? '',
        retryJobId: context.retryableRecalculationJob?.id ?? '',
        needsRecalculationStatusRefresh: context.retryableRecalculationJob === null
          ? this.data.needsRecalculationStatusRefresh || hadRetryableJob
          : false,
        mealMessage: context.retryableRecalculationJob === null && hadRetryableJob
          ? '未发现当前训练计划可重试的餐单重算任务；旧任务可能已不再适用或已由后台处理，请刷新确认最新餐单。'
          : this.data.mealMessage
      });
    } catch (error: unknown) {
      this.setData({
        contextMessage: error instanceof Error
          ? `${error.message} 请检查网络后重试。`
          : '无法读取当前规划，请检查网络后重试。'
      });
    } finally {
      this.setData({ loadingContext: false });
    }
  },

  onInventoryNameInput(event) {
    const index = eventIndex(event.currentTarget.dataset.index, this.data.inventoryRows.length);
    if (index === undefined) return;
    const inventoryRows = replaceRow(this.data.inventoryRows, index, (row) => ({
      ...row,
      name: event.detail.value,
      resolutionToken: row.resolutionToken + 1,
      resolutionStatus: 'idle',
      resolutionMessage: '名称变化后需要重新校验。'
    }));
    this.setData({ inventoryRows, canSaveInventory: rowsResolved(inventoryRows), formError: '' });
  },

  onInventoryGramsInput(event) {
    const index = eventIndex(event.currentTarget.dataset.index, this.data.inventoryRows.length);
    if (index === undefined) return;
    const inventoryRows = replaceRow(this.data.inventoryRows, index, (row) => ({
      ...row,
      availableGrams: event.detail.value,
      resolutionStatus: row.resolutionStatus === 'resolved' ? 'resolved' : 'idle'
    }));
    this.setData({ inventoryRows, canSaveInventory: rowsResolved(inventoryRows), formError: '' });
  },

  onAddInventoryRow() {
    if (this.data.inventoryRows.length >= 200) {
      this.setData({ formError: '一次最多录入 200 行食材。' });
      return;
    }
    this.setData({
      inventoryRows: [...this.data.inventoryRows, {
        key: nextInventoryRowKey(),
        resolutionToken: 0,
        name: '',
        availableGrams: '',
        resolutionStatus: 'idle',
        resolutionMessage: ''
      }],
      canSaveInventory: false,
      formError: ''
    });
  },

  onRemoveInventoryRow(event) {
    const index = eventIndex(event.currentTarget.dataset.index, this.data.inventoryRows.length);
    if (index === undefined || this.data.inventoryRows.length === 1) return;
    const inventoryRows = this.data.inventoryRows.filter((_row, rowIndex) => rowIndex !== index);
    this.setData({ inventoryRows, canSaveInventory: rowsResolved(inventoryRows), formError: '' });
  },

  async onResolveInventoryRow(event) {
    const index = eventIndex(event.currentTarget.dataset.index, this.data.inventoryRows.length);
    if (index === undefined) return;
    const selected = this.data.inventoryRows[index];
    if (selected === undefined || selected.resolutionStatus === 'resolving') return;
    const key = selected.key;
    const requestToken = selected.resolutionToken + 1;
    const rows = replaceRow(this.data.inventoryRows, index, (row) => ({
      ...row,
      key,
      resolutionToken: requestToken,
      resolutionStatus: 'resolving',
      resolutionMessage: '正在校验食材名称…'
    }));
    this.setData({ inventoryRows: rows, canSaveInventory: false, formError: '' });
    try {
      const response = await planningApiClient.call(buildResolveFoodNameRequest(selected.name));
      if (!response.success || response.data.kind !== 'food_name_resolved' || response.data.resolution === null) {
        const resolutionMessage = response.success
          ? '未找到审核食材，请换用更常见的标准名称后重新校验名称。'
          : response.error.code === 'provider_unavailable'
            ? '营养数据暂时不可用，请稍后重新校验名称。'
            : `${mealPlanningErrorMessage(response.error.code)} 请重新校验名称。`;
        this.setData({
          inventoryRows: this.data.inventoryRows.map((row) => (
            row.key === key && row.resolutionToken === requestToken
              ? { ...row, resolutionStatus: 'error', resolutionMessage }
              : row
          ))
        });
      } else {
        const canonicalNameZh = response.data.resolution.canonicalNameZh;
        this.setData({
          inventoryRows: this.data.inventoryRows.map((row) => (
            row.key === key && row.resolutionToken === requestToken
              ? {
                  ...row,
                  name: canonicalNameZh,
                  resolutionStatus: 'resolved',
                  resolutionMessage: `已识别为“${canonicalNameZh}”。`
                }
              : row
          ))
        });
      }
    } catch (error: unknown) {
      this.setData({
        inventoryRows: this.data.inventoryRows.map((row) => (
          row.key === key && row.resolutionToken === requestToken
            ? {
                ...row,
                resolutionStatus: 'error',
                resolutionMessage: error instanceof Error
                  ? `${error.message} 请稍后重新校验名称。`
                  : '名称校验失败，请稍后重新校验名称。'
              }
            : row
        ))
      });
    }
    this.setData({ canSaveInventory: rowsResolved(this.data.inventoryRows) });
  },

  onGenerationWeekChange(event) {
    this.setData({ generationWeekStart: event.detail.value, formError: '' });
  },

  async onSaveInventoryAndGenerate() {
    if (this.data.savingInventory || this.data.generatingMeal) return;
    if (!this.data.canSaveInventory) {
      this.setData({ formError: '请先逐行校验所有食材名称，再保存并生成餐单。' });
      return;
    }
    let inventorySaved = false;
    this.setData({
      savingInventory: true,
      actionMessage: '',
      generationMessage: '',
      formError: ''
    });
    try {
      const inventoryResponse = await callPendingWrite(buildInventoryRequest({
        rows: this.data.inventoryRows,
        expectedVersion: this.data.latestVersions.inventory,
        idempotencyKey: 'inventory-ui-pending-placeholder'
      }), 'inventory_saved', () => idempotencyKey('inventory-ui'));
      if (!inventoryResponse.success || inventoryResponse.data.kind !== 'inventory_saved') {
        this.setData({ formError: responseError(inventoryResponse) });
        return;
      }
      inventorySaved = true;
      this.setData({
        savingInventory: false,
        generatingMeal: true,
        actionMessage: '食材库存已保存。'
      });
      const mealResponse = await callPendingWrite(buildGenerateMealPlanRequest({
        weekStartDate: this.data.generationWeekStart,
        businessToday: this.data.businessToday,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: 'meal-generate-ui-pending-placeholder'
      }), 'weekly_meal_plan_generated', () => idempotencyKey('meal-generate-ui'));
      if (!mealResponse.success || mealResponse.data.kind !== 'weekly_meal_plan_generated') {
        this.setData({ generationMessage: `库存已保存，但餐单生成未完成。${responseError(mealResponse)}` });
        return;
      }
      this.setData({ generationMessage: '一周餐单已生成，所有营养数值均为估算。' });
    } catch (error: unknown) {
      this.setData({
        generationMessage: inventorySaved
          ? `库存已保存，但餐单生成未完成。${error instanceof Error ? error.message : '请稍后重试。'}`
          : `库存未保存。${error instanceof Error ? error.message : '请检查网络后重试。'}`
      });
    } finally {
      this.setData({ savingInventory: false, generatingMeal: false });
      if (inventorySaved) await this.refreshContext();
    }
  },

  async onLockChange(event) {
    if (this.data.updatingMeal) return;
    const index = eventIndex(event.currentTarget.dataset.index, this.data.mealDays.length);
    const day = index === undefined ? undefined : this.data.mealDays[index];
    if (day === undefined) return;
    this.setData({ updatingMeal: true, formError: '', actionMessage: '' });
    try {
      const response = await callPendingWrite(buildLockRequest({
        businessDate: day.businessDate,
        businessToday: this.data.businessToday,
        locked: event.detail.value,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: 'meal-lock-ui-pending-placeholder'
      }), 'meal_plan_updated', () => idempotencyKey('meal-lock-ui'));
      if (!response.success || response.data.kind !== 'meal_plan_updated') {
        this.setData({ formError: responseError(response) });
        return;
      }
      this.setData({ actionMessage: event.detail.value ? '该日餐单已锁定。' : '该日餐单已解锁。' });
      await this.refreshContext();
    } catch (error: unknown) {
      this.setData({ formError: error instanceof Error ? error.message : '锁定操作失败，请重试。' });
    } finally {
      this.setData({ updatingMeal: false });
    }
  },

  async onRecipeChange(event) {
    if (this.data.updatingMeal || !this.data.recipeSelectionAvailable) return;
    const dayIndex = eventIndex(event.currentTarget.dataset.dayIndex, this.data.mealDays.length);
    const day = dayIndex === undefined ? undefined : this.data.mealDays[dayIndex];
    const mealIndex = day === undefined
      ? undefined
      : eventIndex(event.currentTarget.dataset.mealIndex, day.meals.length);
    const meal = mealIndex === undefined ? undefined : day?.meals[mealIndex];
    if (day === undefined || meal === undefined) return;
    const selectedRecipeIndex = eventIndex(event.detail.value, this.data.selectableRecipes.length);
    if (selectedRecipeIndex === undefined) {
      this.setData({ formError: '请选择服务端提供的备选菜品。' });
      return;
    }
    this.setData({ updatingMeal: true, formError: '', actionMessage: '' });
    try {
      const response = await callPendingWrite(buildRecipeEditRequest({
        businessDate: day.businessDate,
        businessToday: this.data.businessToday,
        slot: meal.slot,
        selectedRecipeIndex,
        recipeOptions: this.data.selectableRecipes,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: 'meal-edit-ui-pending-placeholder'
      }), 'meal_plan_updated', () => idempotencyKey('meal-edit-ui'));
      if (!response.success || response.data.kind !== 'meal_plan_updated') {
        this.setData({ formError: responseError(response) });
        return;
      }
      this.setData({ actionMessage: '菜品已替换并重新校验营养与库存。' });
      await this.refreshContext();
    } catch (error: unknown) {
      this.setData({ formError: error instanceof Error ? error.message : '换菜失败，请重试。' });
    } finally {
      this.setData({ updatingMeal: false });
    }
  },

  onCandidateDecisionChange(event) {
    if (event.detail.value === 'keep_existing' || event.detail.value === 'overwrite_locked') {
      this.setData({ selectedDecision: event.detail.value, formError: '' });
    }
  },

  async onConfirmCandidateDecision() {
    if (this.data.decidingCandidate || this.data.pendingCandidateId.length === 0) return;
    this.setData({ decidingCandidate: true, formError: '', actionMessage: '' });
    try {
      const response = await callPendingWrite(buildCandidateDecisionRequest({
        candidateMealPlanVersionId: this.data.pendingCandidateId,
        decision: this.data.selectedDecision,
        expectedVersion: this.data.latestVersions.mealPlanDecision,
        idempotencyKey: 'meal-decision-ui-pending-placeholder'
      }), 'meal_plan_candidate_decided', () => idempotencyKey('meal-decision-ui'));
      if (!response.success || response.data.kind !== 'meal_plan_candidate_decided') {
        this.setData({ formError: responseError(response) });
        return;
      }
      this.setData({ actionMessage: this.data.selectedDecision === 'keep_existing'
        ? '已保留当前锁定餐单。'
        : '已确认覆盖锁定日并启用新餐单。' });
      await this.refreshContext();
    } catch (error: unknown) {
      this.setData({ formError: error instanceof Error ? error.message : '差异处理失败，请重试。' });
    } finally {
      this.setData({ decidingCandidate: false });
    }
  },

  onCompletionDateChange(event) {
    this.setData({ completionDate: event.detail.value, formError: '' });
  },

  onCompletionMinutesInput(event) {
    this.setData({ completedDurationMinutes: event.detail.value, formError: '' });
  },

  async onRecordCompletion() {
    if (this.data.savingFact) return;
    this.setData({
      savingFact: true,
      factMessage: '',
      mealMessage: '',
      recalculatingMeal: false,
      formError: ''
    });
    try {
      const response = await callPendingWrite(buildCompletionRequest({
        businessDate: this.data.completionDate,
        businessToday: this.data.businessToday,
        completedDurationMinutes: this.data.completedDurationMinutes,
        expectedVersion: this.data.latestVersions.trainingCompletion,
        idempotencyKey: 'training-completion-ui-pending-placeholder'
      }), 'training_completion_recorded', () => idempotencyKey('training-completion-ui'));
      const feedback = buildCompletionFeedback(response);
      this.setData({
        factMessage: feedback.factMessage,
        mealMessage: feedback.mealMessage,
        retryJobId: feedback.retryJobId,
        needsRecalculationStatusRefresh: feedback.needsStatusRefresh
      });
      if (response.success && response.data.kind === 'training_completion_recorded') {
        await this.refreshContext();
      }
    } catch (error: unknown) {
      this.setData({
        formError: error instanceof Error
          ? `${error.message} 请检查输入后重试。`
          : '训练完成情况未保存，请检查输入后重试。'
      });
    } finally {
      this.setData({ savingFact: false, recalculatingMeal: false });
    }
  },

  async onRetryRecalculation() {
    if (this.data.recalculatingMeal || this.data.retryJobId.length === 0) return;
    this.setData({ recalculatingMeal: true, mealMessage: '', formError: '' });
    try {
      const response = await callPendingWrite(buildRetryRequest({
        recalculationJobId: this.data.retryJobId,
        expectedVersion: this.data.latestVersions.recalculationJob,
        idempotencyKey: 'meal-retry-ui-pending-placeholder'
      }), 'meal_plan_recalculation_processed', () => idempotencyKey('meal-retry-ui'));
      if (!response.success || response.data.kind !== 'meal_plan_recalculation_processed') {
        this.setData({ mealMessage: responseError(response) });
        return;
      }
      this.setData({ retryJobId: '', needsRecalculationStatusRefresh: false, mealMessage: response.data.targetDiffs.length > 0
        ? '餐单重算已完成，请处理锁定日差异。'
        : '餐单重算已完成。' });
      await this.refreshContext();
    } catch (error: unknown) {
      this.setData({
        mealMessage: error instanceof Error
          ? `${error.message} 训练事实已保存，请稍后再次重试。`
          : '餐单重算仍未完成，训练事实已保存，请稍后再次重试。'
      });
    } finally {
      this.setData({ recalculatingMeal: false });
    }
  }
});
