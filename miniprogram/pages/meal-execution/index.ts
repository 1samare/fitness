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

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type LatestVersions = CurrentContext['latestVersions'];

interface InventoryRow extends InventoryRowInput {
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
  staleBanner: string;
  pendingDiffs: readonly { readonly businessDate: string; readonly reasonText: string }[];
  decisionOptions: readonly { readonly value: CandidateDecision; readonly label: string }[];
  selectedDecision: CandidateDecision;
  pendingCandidateId: string;
  retryJobId: string;
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
  trainingCompletion: 0
};

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

function successKind<TKind extends SuccessData['kind']>(
  response: PlanningApiResponse,
  kind: TKind
): response is Extract<PlanningApiResponse, { success: true }> & {
  readonly data: Extract<SuccessData, { kind: TKind }>;
} {
  return response.success && response.data.kind === kind;
}

Page<PageData, PageActions>({
  data: {
    inventoryRows: [{
      name: '',
      availableGrams: '',
      resolutionStatus: 'idle',
      resolutionMessage: ''
    }],
    canSaveInventory: false,
    generationWeekStart: '',
    mealDays: [],
    selectableRecipes: [],
    staleBanner: '',
    pendingDiffs: [],
    decisionOptions: [],
    selectedDecision: 'keep_existing',
    pendingCandidateId: '',
    retryJobId: '',
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
    mealMessage: ''
  },

  async onLoad() {
    await this.refreshContext();
  },

  async refreshContext() {
    if (this.data.loadingContext) return;
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
        staleBanner: viewModel.staleBanner,
        pendingDiffs: viewModel.pendingDiffs,
        decisionOptions: viewModel.decisionOptions,
        pendingCandidateId: context.pendingMealPlanCandidate?.id ?? ''
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
    let rows = replaceRow(this.data.inventoryRows, index, (row) => ({
      ...row,
      resolutionStatus: 'resolving',
      resolutionMessage: '正在校验食材名称…'
    }));
    this.setData({ inventoryRows: rows, canSaveInventory: false, formError: '' });
    try {
      const response = await planningApiClient.call(buildResolveFoodNameRequest(selected.name));
      if (!successKind(response, 'food_name_resolved') || response.data.resolution === null) {
        rows = replaceRow(rows, index, (row) => ({
          ...row,
          resolutionStatus: 'error',
          resolutionMessage: response.success
            ? '未找到审核食材，请换用更常见的标准名称。'
            : mealPlanningErrorMessage(response.error.code)
        }));
      } else {
        rows = replaceRow(rows, index, (row) => ({
          ...row,
          name: response.data.resolution?.canonicalNameZh ?? row.name,
          resolutionStatus: 'resolved',
          resolutionMessage: `已识别为“${response.data.resolution?.canonicalNameZh ?? row.name}”。`
        }));
      }
    } catch (error: unknown) {
      rows = replaceRow(rows, index, (row) => ({
        ...row,
        resolutionStatus: 'error',
        resolutionMessage: error instanceof Error
          ? `${error.message} 请稍后重试名称校验。`
          : '名称校验失败，请稍后重试。'
      }));
    }
    this.setData({ inventoryRows: rows, canSaveInventory: rowsResolved(rows) });
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
      mealMessage: '',
      formError: ''
    });
    try {
      const inventoryResponse = await planningApiClient.call(buildInventoryRequest({
        rows: this.data.inventoryRows,
        expectedVersion: this.data.latestVersions.inventory,
        idempotencyKey: idempotencyKey('inventory-ui')
      }));
      if (!successKind(inventoryResponse, 'inventory_saved')) {
        this.setData({ formError: responseError(inventoryResponse) });
        return;
      }
      inventorySaved = true;
      this.setData({
        savingInventory: false,
        generatingMeal: true,
        actionMessage: '食材库存已保存。'
      });
      const mealResponse = await planningApiClient.call(buildGenerateMealPlanRequest({
        weekStartDate: this.data.generationWeekStart,
        businessToday: this.data.businessToday,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: idempotencyKey('meal-generate-ui')
      }));
      if (!successKind(mealResponse, 'weekly_meal_plan_generated')) {
        this.setData({ mealMessage: responseError(mealResponse) });
        return;
      }
      this.setData({ mealMessage: '一周餐单已生成，所有营养数值均为估算。' });
    } catch (error: unknown) {
      this.setData({
        mealMessage: error instanceof Error
          ? `${error.message} 已保存的内容不会丢失，请稍后重试。`
          : '操作未完成，已保存的内容不会丢失，请稍后重试。'
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
      const response = await planningApiClient.call(buildLockRequest({
        businessDate: day.businessDate,
        businessToday: this.data.businessToday,
        locked: event.detail.value,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: idempotencyKey('meal-lock-ui')
      }));
      if (!successKind(response, 'meal_plan_updated')) {
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
    if (this.data.updatingMeal) return;
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
      const response = await planningApiClient.call(buildRecipeEditRequest({
        businessDate: day.businessDate,
        businessToday: this.data.businessToday,
        slot: meal.slot,
        selectedRecipeIndex,
        recipeOptions: this.data.selectableRecipes,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: idempotencyKey('meal-edit-ui')
      }));
      if (!successKind(response, 'meal_plan_updated')) {
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
      const response = await planningApiClient.call(buildCandidateDecisionRequest({
        candidateMealPlanVersionId: this.data.pendingCandidateId,
        decision: this.data.selectedDecision,
        expectedVersion: this.data.latestVersions.mealPlanDecision,
        idempotencyKey: idempotencyKey('meal-decision-ui')
      }));
      if (!successKind(response, 'meal_plan_candidate_decided')) {
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
      const response = await planningApiClient.call(buildCompletionRequest({
        businessDate: this.data.completionDate,
        businessToday: this.data.businessToday,
        completedDurationMinutes: this.data.completedDurationMinutes,
        expectedVersion: this.data.latestVersions.trainingCompletion,
        idempotencyKey: idempotencyKey('training-completion-ui')
      }));
      const feedback = buildCompletionFeedback(response);
      this.setData({
        factMessage: feedback.factMessage,
        mealMessage: feedback.mealMessage,
        retryJobId: feedback.retryJobId
      });
      if (successKind(response, 'training_completion_recorded')) await this.refreshContext();
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
      const response = await planningApiClient.call(buildRetryRequest({
        recalculationJobId: this.data.retryJobId,
        expectedVersion: this.data.latestVersions.mealPlan,
        idempotencyKey: idempotencyKey('meal-retry-ui')
      }));
      if (!successKind(response, 'meal_plan_recalculation_processed')) {
        this.setData({ mealMessage: responseError(response) });
        return;
      }
      this.setData({ retryJobId: '', mealMessage: response.data.targetDiffs.length > 0
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
