import { createFitnessAssistantAgent } from '@fitness/agent';
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
});
