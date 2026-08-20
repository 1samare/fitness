import type { AssistantApiResponse } from '@fitness/contracts';

type AssistantSuccessData = Extract<AssistantApiResponse, { success: true }>['data'];
type AssistantConversationData = Extract<
  AssistantSuccessData,
  { kind: 'assistant_conversation' }
>;
export type AssistantRecoveryAction =
  | 'none'
  | 'retry'
  | 'open_training_plan'
  | 'open_meal_plan'
  | 'review_meal_plan_changes';

export const ASSISTANT_CAPABILITY_EXAMPLES = [
  '把 2026-08-21 的训练移到 2026-08-22',
  '把 2026-08-21 的午餐换成番茄牛肉',
  '把 2026-08-21 的晚餐调整为 1.2 倍'
] as const;

export interface AssistantMessageViewModel {
  readonly messageKey: string;
  readonly turnId: string;
  readonly role: 'user' | 'assistant';
  readonly roleLabel: '你' | '助手';
  readonly content: string;
  readonly createdAt: string;
}

export interface AssistantConversationViewModel {
  readonly conversationVersion: number;
  readonly messages: readonly AssistantMessageViewModel[];
}

export function createAssistantConversationViewModel(
  conversation: AssistantConversationData
): AssistantConversationViewModel {
  return {
    conversationVersion: conversation.conversationVersion,
    messages: conversation.messages.slice(-12).map((message) => ({
      messageKey: `${message.turnId}:${message.role}`,
      turnId: message.turnId,
      role: message.role,
      roleLabel: message.role === 'user' ? '你' : '助手',
      content: message.content,
      createdAt: message.createdAt
    }))
  };
}

export function recoveryActionViewModel(action: AssistantRecoveryAction): {
  readonly showRetry: boolean;
  readonly showTrainingPlan: boolean;
  readonly showMealPlan: boolean;
} {
  return {
    showRetry: action === 'retry',
    showTrainingPlan: action === 'open_training_plan',
    showMealPlan: action === 'open_meal_plan' || action === 'review_meal_plan_changes'
  };
}
