import {
  createFitnessAssistantAgent,
  type AssistantLanguageModelProvider
} from '@fitness/agent';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeAssistantHandler } from './runtime-handler';

describe('local assistant runtime composition', () => {
  it('creates exactly one compiled Agent and reuses it across requests', async () => {
    const createAgent = vi.fn(createFitnessAssistantAgent);
    const handler = createRuntimeAssistantHandler({
      runtimeMode: 'local',
      createAgent,
      now: () => '2026-08-20T00:00:00.000Z'
    });
    const context = { userId: 'local-user' } as const;

    await expect(handler({ action: 'getAssistantConversation' }, context))
      .resolves.toMatchObject({
        success: true,
        data: { kind: 'assistant_conversation', conversationVersion: 0 }
      });
    await expect(handler({ action: 'getAssistantConversation' }, context))
      .resolves.toMatchObject({ success: true });
    expect(createAgent).toHaveBeenCalledOnce();
  });

  it('uses the deterministic local model but keeps domain prerequisites fail-closed', async () => {
    const handler = createRuntimeAssistantHandler({
      runtimeMode: 'local',
      now: () => '2026-08-20T00:00:00.000Z'
    });
    const response = await handler({
      action: 'sendAssistantMessage',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'assistant-local-0001',
        message: '把 2026-08-24 的训练移到 2026-08-25'
      }
    }, { userId: 'local-user' });

    expect(response).toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        conversationVersion: 1,
        result: { kind: 'command_rejected' }
      }
    });
    expect(JSON.stringify(response)).not.toContain('planning_context_unavailable');
  });

  it.each([
    {
      suffix: 'replace',
      message: '把午餐换成番茄牛肉',
      output: {
        kind: 'clarify', intent: 'replace_meal', missingFields: ['business_date']
      },
      pendingClarification: {
        intent: 'replace_meal', businessDate: null, slot: 'lunch',
        dishNameZh: '番茄牛肉', missingFields: ['business_date']
      }
    },
    {
      suffix: 'move',
      message: '2026-08-24 和 2026-08-25 哪天是原训练日？',
      output: {
        kind: 'clarify', intent: 'move_training_day', missingFields: ['target_date']
      },
      pendingClarification: {
        intent: 'move_training_day', sourceDate: null, targetDate: null,
        missingFields: ['source_date', 'target_date']
      }
    },
    {
      suffix: 'resize',
      message: '把午餐调成 1 倍还是 1.2 倍？',
      output: {
        kind: 'clarify', intent: 'resize_meal_portion', missingFields: ['business_date']
      },
      pendingClarification: {
        intent: 'resize_meal_portion', businessDate: null, slot: 'lunch', multiplier: null,
        missingFields: ['business_date', 'multiplier']
      }
    }
  ])('persists and finalizes a schema-safe partial $suffix clarification', async ({
    suffix,
    message,
    output,
    pendingClarification
  }) => {
    const provider: AssistantLanguageModelProvider = {
      generateIntent: () => Promise.resolve({ rawText: JSON.stringify(output) })
    };
    const handler = createRuntimeAssistantHandler({
      runtimeMode: 'local',
      provider,
      now: () => '2026-08-20T00:00:00.000Z'
    });
    const context = { userId: `partial-${suffix}` } as const;

    await expect(handler({
      action: 'sendAssistantMessage',
      payload: {
        expectedVersion: 0,
        idempotencyKey: `assistant-partial-${suffix}`,
        message
      }
    }, context)).resolves.toMatchObject({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        conversationVersion: 1,
        result: { kind: 'clarification_required', pendingClarification }
      }
    });
    await expect(handler({ action: 'getAssistantConversation' }, context))
      .resolves.toMatchObject({
        success: true,
        data: { kind: 'assistant_conversation', conversationVersion: 1, pendingTurn: null }
      });
  });
});
