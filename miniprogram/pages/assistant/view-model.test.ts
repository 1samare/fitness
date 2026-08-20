import { describe, expect, it } from 'vitest';
import type { AssistantApiResponse } from '@fitness/contracts';
import {
  ASSISTANT_CAPABILITY_EXAMPLES,
  createAssistantConversationViewModel,
  recoveryActionViewModel
} from './view-model';

type ConversationData = Extract<
  Extract<AssistantApiResponse, { success: true }>['data'],
  { kind: 'assistant_conversation' }
>;

function conversationWith(messageCount: number): ConversationData {
  return {
    kind: 'assistant_conversation',
    conversationVersion: 9,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      turnId: `turn-${String(index)}`,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === messageCount - 1 ? '**纯文本** <script>不会执行</script>' : `消息 ${String(index)}`,
      createdAt: `2026-08-20T00:${String(index).padStart(2, '0')}:00.000Z`
    })),
    pendingTurn: null,
    supportedCommands: ['move_training_day', 'replace_meal', 'resize_meal_portion']
  };
}

describe('assistant page view model', () => {
  it('renders only the newest 12 messages and preserves content as plain text', () => {
    const viewModel = createAssistantConversationViewModel(conversationWith(14));

    expect(viewModel.messages).toHaveLength(12);
    expect(viewModel.messages[0]?.turnId).toBe('turn-2');
    expect(viewModel.messages.at(-1)).toMatchObject({
      roleLabel: '助手', content: '**纯文本** <script>不会执行</script>'
    });
    expect(viewModel.conversationVersion).toBe(9);
  });

  it('gives paired user and assistant messages from one turn distinct render keys', () => {
    const data = conversationWith(0);
    const viewModel = createAssistantConversationViewModel({
      ...data,
      messages: [
        {
          turnId: 'assistant-turn-paired',
          role: 'user',
          content: '把午餐换成番茄牛肉',
          createdAt: '2026-08-20T00:00:00.000Z'
        },
        {
          turnId: 'assistant-turn-paired',
          role: 'assistant',
          content: '还需要业务日期。',
          createdAt: '2026-08-20T00:00:01.000Z'
        }
      ]
    });

    expect(viewModel.messages.map((message) => message.messageKey)).toEqual([
      'assistant-turn-paired:user',
      'assistant-turn-paired:assistant'
    ]);
    expect(new Set(viewModel.messages.map((message) => message.messageKey)).size).toBe(2);
  });

  it('provides three fixed examples without submission metadata', () => {
    expect(ASSISTANT_CAPABILITY_EXAMPLES).toEqual([
      '把 2026-08-21 的训练移到 2026-08-22',
      '把 2026-08-21 的午餐换成番茄牛肉',
      '把 2026-08-21 的晚餐调整为 1.2 倍'
    ]);
    expect(JSON.stringify(ASSISTANT_CAPABILITY_EXAMPLES)).not.toMatch(
      /idempotencyKey|expectedVersion|provider|model|tool/
    );
  });

  it.each([
    ['none', false, false, false],
    ['retry', true, false, false],
    ['open_training_plan', false, true, false],
    ['open_meal_plan', false, false, true],
    ['review_meal_plan_changes', false, false, true]
  ] as const)(
    'maps %s to fixed recovery controls',
    (action, showRetry, showTrainingPlan, showMealPlan) => {
      expect(recoveryActionViewModel(action)).toEqual({
        showRetry, showTrainingPlan, showMealPlan
      });
    }
  );
});
