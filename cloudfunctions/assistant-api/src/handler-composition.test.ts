import type {
  AssistantLanguageModelProvider,
  FitnessAssistantAgent
} from '@fitness/agent';
import type {
  AssistantPlanningContextPort,
  PlanningAssistantCommandPort,
  PlanningAssistantContext
} from '@fitness/application';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantApiComposition } from './handler';

const now = () => '2026-08-20T00:00:00.000Z';

function request(idempotencyKey: string, expectedVersion = 0) {
  return {
    action: 'sendAssistantMessage' as const,
    payload: {
      expectedVersion,
      idempotencyKey,
      message: '把 2026-08-24 的训练移到 2026-08-25'
    }
  };
}

function planningContext(): PlanningAssistantContext & Awaited<
  ReturnType<AssistantPlanningContextPort['getCurrentContext']>
> {
  return {
    bodyProfile: { payload: { businessTimezone: 'Asia/Shanghai' } },
    trainingPlan: {
      version: 2,
      payload: {
        weekStartDate: '2026-08-24',
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-24',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    },
    mealPlan: { version: 3, days: [] },
    selectableRecipes: [],
    latestVersions: { trainingPlan: 2, mealPlan: 3 }
  };
}

function planningPort(
  saveTrainingPlan: PlanningAssistantCommandPort['saveTrainingPlan'] = () => Promise.resolve({})
): PlanningAssistantCommandPort & AssistantPlanningContextPort {
  return {
    getCurrentContext: () => Promise.resolve(planningContext()),
    saveTrainingPlan,
    updateMealPlanDay: () => Promise.resolve({}),
    resizeMealPlanPortion: () => Promise.resolve({})
  };
}

const commandProvider: AssistantLanguageModelProvider = {
  generateIntent: () => Promise.resolve({
    rawText: JSON.stringify({
      kind: 'command',
      intent: 'move_training_day',
      evidence: {
        sourceDateText: '2026-08-24',
        targetDateText: '2026-08-25'
      }
    })
  })
};

describe('assistant API real composition recovery', () => {
  it('finalizes a received turn after a pre-authorization internal failure', async () => {
    const repository = new InMemoryPlanningRepository();
    const failingAgent: FitnessAssistantAgent = {
      invoke: () => Promise.reject(new Error('stable decide defect'))
    };
    let id = 0;
    const handler = createAssistantApiComposition({
      repository,
      planning: planningPort(),
      provider: commandProvider,
      now,
      nextId: (prefix) => `${prefix}-${String(++id).padStart(4, '0')}`,
      createAgent: () => failingAgent
    });
    const context = { userId: 'pre-authorization-user' } as const;

    await expect(handler(request('assistant-preauth-0001'), context)).resolves.toMatchObject({
      success: true,
      data: {
        conversationVersion: 1,
        result: { kind: 'assistant_unavailable', reason: 'internal_error' }
      }
    });
    await expect(handler({ action: 'getAssistantConversation' }, context)).resolves.toMatchObject({
      success: true,
      data: { conversationVersion: 1, pendingTurn: null }
    });
    await expect(handler(request('assistant-preauth-0002', 1), context)).resolves.toMatchObject({
      success: true,
      data: { conversationVersion: 2 }
    });
  });

  it('preserves a validated turn and replays one committed command after response loss', async () => {
    const repository = new InMemoryPlanningRepository();
    const committedKeys = new Set<string>();
    let saveAttempts = 0;
    const planning = planningPort((_userId, envelope) => {
      saveAttempts += 1;
      if (!committedKeys.has(envelope.idempotencyKey)) {
        committedKeys.add(envelope.idempotencyKey);
        return Promise.reject(new Error('response lost after commit'));
      }
      return Promise.resolve({});
    });
    const generateIntent = vi.fn(commandProvider.generateIntent);
    let id = 0;
    const handler = createAssistantApiComposition({
      repository,
      planning,
      provider: { generateIntent },
      now,
      nextId: (prefix) => `${prefix}-${String(++id).padStart(4, '0')}`
    });
    const context = { userId: 'response-loss-user' } as const;
    const input = request('assistant-response-loss-0001');

    await expect(handler(input, context)).resolves.toMatchObject({
      success: false,
      error: { code: 'internal_error' }
    });
    await expect(handler({ action: 'getAssistantConversation' }, context)).resolves.toMatchObject({
      success: true,
      data: {
        conversationVersion: 0,
        pendingTurn: { idempotencyKey: 'assistant-response-loss-0001' }
      }
    });
    await expect(handler(input, context)).resolves.toMatchObject({
      success: true,
      data: {
        conversationVersion: 1,
        result: { kind: 'command_executed', command: 'move_training_day' }
      }
    });
    expect(saveAttempts).toBe(2);
    expect(generateIntent).toHaveBeenCalledOnce();
    expect(committedKeys).toEqual(new Set(['assistant-domain-assistant-turn-0001']));
  });
});
