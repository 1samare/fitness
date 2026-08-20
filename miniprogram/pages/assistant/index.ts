import type { AssistantApiResponse } from '@fitness/contracts';
import { assistantApiClient } from '../../services/assistant-api';
import { planningApiClient } from '../../services/planning-api';
import {
  parsePendingAssistantCommand,
  pendingAssistantCommandMatches,
  pendingAssistantCommandStorageKey,
  selectPendingAssistantCommand,
  type PendingAssistantCommand
} from './pending-command';
import {
  ASSISTANT_CAPABILITY_EXAMPLES,
  createAssistantConversationViewModel,
  recoveryActionViewModel,
  type AssistantMessageViewModel,
  type AssistantRecoveryAction
} from './view-model';

type AssistantSuccessData = Extract<AssistantApiResponse, { success: true }>['data'];
type AssistantConversationData = Extract<
  AssistantSuccessData,
  { kind: 'assistant_conversation' }
>;
type AssistantTurnData = Extract<
  AssistantSuccessData,
  { kind: 'assistant_turn_completed' }
>;

interface TextValueEvent { readonly detail: { readonly value: string } }

interface PageData {
  readonly examples: readonly string[];
  messages: readonly AssistantMessageViewModel[];
  conversationVersion: number;
  messageInput: string;
  loadingConversation: boolean;
  sending: boolean;
  statusMessage: string;
  errorMessage: string;
  showRetryRecovery: boolean;
  showTrainingPlanRecovery: boolean;
  showMealPlanRecovery: boolean;
  lastSubmittedMessage: string;
}

interface PageActions {
  onLoad(): Promise<void>;
  onMessageInput(event: TextValueEvent): void;
  onSend(): Promise<void>;
  onRetry(): Promise<void>;
  onOpenTrainingPlan(): void;
  onOpenMealPlan(): void;
}

interface AssistantPageContext {
  data: PageData;
  setData(patch: Partial<PageData>): void;
}

function nextIdempotencyKey(): string {
  const randomPart = Math.random().toString(36).slice(2);
  return `assistant-message-${String(Date.now())}-${randomPart}`;
}

function recoveryActionForTurn(data: AssistantTurnData): AssistantRecoveryAction {
  const result = data.result;
  if (
    result.kind === 'command_executed'
    || result.kind === 'assistant_unavailable'
    || result.kind === 'command_rejected'
  ) return result.recoveryAction;
  return 'none';
}

function setRecovery(page: AssistantPageContext, action: AssistantRecoveryAction): void {
  const viewModel = recoveryActionViewModel(action);
  page.setData({
    showRetryRecovery: viewModel.showRetry,
    showTrainingPlanRecovery: viewModel.showTrainingPlan,
    showMealPlanRecovery: viewModel.showMealPlan
  });
}

function storedPending(): PendingAssistantCommand | undefined {
  return parsePendingAssistantCommand(wx.getStorageSync(pendingAssistantCommandStorageKey));
}

function applyConversation(
  page: AssistantPageContext,
  conversation: AssistantConversationData
): void {
  const viewModel = createAssistantConversationViewModel(conversation);
  page.setData({
    conversationVersion: viewModel.conversationVersion,
    messages: viewModel.messages
  });
}

async function fetchConversation(
  page: AssistantPageContext,
  recoverPending: boolean
): Promise<PendingAssistantCommand | undefined> {
  const response = await assistantApiClient.call({ action: 'getAssistantConversation' });
  if (!response.success) {
    page.setData({ errorMessage: response.error.message });
    setRecovery(page, response.error.recoveryAction);
    return undefined;
  }
  if (response.data.kind !== 'assistant_conversation') {
    page.setData({ errorMessage: '助手会话读取未确认，请稍后重试。' });
    return undefined;
  }
  applyConversation(page, response.data);
  if (!recoverPending) return undefined;

  const localPending = storedPending();
  const serverPending = response.data.pendingTurn;
  if (serverPending === null) {
    if (localPending !== undefined) wx.removeStorageSync(pendingAssistantCommandStorageKey);
    return undefined;
  }
  if (
    localPending === undefined
    || !pendingAssistantCommandMatches(localPending, serverPending)
  ) {
    page.setData({
      errorMessage: '本地与服务端恢复记录不一致，未自动重放。请前往结构化页面核对当前计划。',
      showTrainingPlanRecovery: true,
      showMealPlanRecovery: true
    });
    return undefined;
  }
  return localPending;
}

async function refreshPlanningContext(): Promise<void> {
  try {
    await planningApiClient.call({ action: 'getCurrentContext' });
  } catch {
    // The deterministic planning pages remain independently recoverable.
  }
}

async function submitPending(
  page: AssistantPageContext,
  pending: PendingAssistantCommand
): Promise<void> {
  if (page.data.sending) return;
  page.setData({
    sending: true,
    errorMessage: '',
    statusMessage: '',
    showRetryRecovery: false,
    showTrainingPlanRecovery: false,
    showMealPlanRecovery: false
  });
  try {
    const response = await assistantApiClient.call({
      action: 'sendAssistantMessage',
      payload: pending
    });
    if (!response.success) {
      page.setData({ errorMessage: response.error.message });
      setRecovery(page, response.error.recoveryAction);
      return;
    }
    if (response.data.kind !== 'assistant_turn_completed') {
      page.setData({ errorMessage: '助手请求未得到终态确认，请重试原请求。' });
      setRecovery(page, 'retry');
      return;
    }

    wx.removeStorageSync(pendingAssistantCommandStorageKey);
    const recoveryAction = recoveryActionForTurn(response.data);
    page.setData({
      conversationVersion: response.data.conversationVersion,
      messageInput: '',
      statusMessage: response.data.result.message,
      lastSubmittedMessage: recoveryAction === 'retry' ? pending.message : ''
    });
    setRecovery(page, recoveryAction);
    if (response.data.result.kind === 'command_executed') {
      await refreshPlanningContext();
    }
    await fetchConversation(page, false);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '助手服务暂时不可用。';
    page.setData({
      errorMessage: `${message} 已保留原请求，可点击重试。`,
      showRetryRecovery: true
    });
  } finally {
    page.setData({ sending: false });
  }
}

Page<PageData, PageActions>({
  data: {
    examples: ASSISTANT_CAPABILITY_EXAMPLES,
    messages: [],
    conversationVersion: 0,
    messageInput: '',
    loadingConversation: false,
    sending: false,
    statusMessage: '',
    errorMessage: '',
    showRetryRecovery: false,
    showTrainingPlanRecovery: false,
    showMealPlanRecovery: false,
    lastSubmittedMessage: ''
  },

  async onLoad() {
    this.setData({ loadingConversation: true, errorMessage: '' });
    try {
      const pending = await fetchConversation(this, true);
      if (pending !== undefined) await submitPending(this, pending);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '助手会话暂时不可用。';
      this.setData({ errorMessage: message, showRetryRecovery: true });
    } finally {
      this.setData({ loadingConversation: false });
    }
  },

  onMessageInput(event) {
    this.setData({ messageInput: event.detail.value.slice(0, 2_000) });
  },

  async onSend() {
    if (this.data.sending || this.data.loadingConversation) return;
    const message = this.data.messageInput.trim();
    if (message.length === 0) {
      this.setData({ errorMessage: '请输入要修改的训练或餐单内容。' });
      return;
    }
    const existing = storedPending();
    if (
      existing !== undefined
      && (existing.expectedVersion !== this.data.conversationVersion || existing.message !== message)
    ) {
      this.setData({
        errorMessage: '上一次请求仍待确认，请先点击重试，不能用新消息覆盖。',
        showRetryRecovery: true
      });
      return;
    }
    const selected = selectPendingAssistantCommand({
      expectedVersion: this.data.conversationVersion,
      message,
      pending: existing,
      nextKey: nextIdempotencyKey
    });
    wx.setStorageSync(pendingAssistantCommandStorageKey, selected.pending);
    await submitPending(this, selected.pending);
  },

  async onRetry() {
    if (this.data.sending || this.data.loadingConversation) return;
    const pending = storedPending();
    if (pending !== undefined) {
      await submitPending(this, pending);
      return;
    }
    if (this.data.lastSubmittedMessage.length > 0) {
      const selected = selectPendingAssistantCommand({
        expectedVersion: this.data.conversationVersion,
        message: this.data.lastSubmittedMessage,
        pending: undefined,
        nextKey: nextIdempotencyKey
      });
      wx.setStorageSync(pendingAssistantCommandStorageKey, selected.pending);
      await submitPending(this, selected.pending);
      return;
    }
    this.setData({ loadingConversation: true, errorMessage: '' });
    try {
      const recovered = await fetchConversation(this, true);
      if (recovered !== undefined) await submitPending(this, recovered);
    } finally {
      this.setData({ loadingConversation: false });
    }
  },

  onOpenTrainingPlan() {
    void wx.navigateTo({ url: '/pages/planning-setup/index' });
  },

  onOpenMealPlan() {
    void wx.navigateTo({ url: '/pages/meal-execution/index' });
  }
});
