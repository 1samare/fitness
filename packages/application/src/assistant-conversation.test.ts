import type {
  AssistantTurnResult,
  AssistantValidatedCommand
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningRepository } from './versioned-planning';
import {
  AssistantCommandMismatchError,
  AssistantConversationBusyError,
  AssistantConversationVersionConflictError,
  createAssistantConversationService
} from './assistant-conversation';
import { IdempotencyKeyReuseError } from './versioned-planning';

const movedCommand: AssistantValidatedCommand = {
  kind: 'move_training_day',
  sourceDate: '2026-08-24',
  targetDate: '2026-08-25'
};

const successResult: AssistantTurnResult = {
  kind: 'command_executed',
  command: 'move_training_day',
  message: '训练日已移动。',
  recoveryAction: 'none'
};

const providerFailure: AssistantTurnResult = {
  kind: 'assistant_unavailable',
  reason: 'provider_unavailable',
  message: '助手服务暂时不可用。',
  recoveryAction: 'retry'
};

function harness(repository: PlanningRepository = new InMemoryPlanningRepository()) {
  let id = 0;
  let nowIndex = 0;
  const planningContext = {
    trainingPlan: {
      version: 3,
      payload: { weekStartDate: '2026-08-24' }
    },
    mealPlan: {
      version: 7,
      days: [
        { businessDate: '2026-08-26', locked: true, manuallyModified: false },
        { businessDate: '2026-08-25', locked: false, manuallyModified: true },
        { businessDate: '2026-08-27', locked: false, manuallyModified: false }
      ]
    },
    latestVersions: { trainingPlan: 3, mealPlan: 7 }
  };
  const service = createAssistantConversationService({
    repository,
    planning: {
      getCurrentContext: vi.fn(() => Promise.resolve(planningContext))
    },
    now: () => new Date(Date.UTC(2026, 7, 20, 0, nowIndex++, 0)).toISOString(),
    nextId: () => `assistant-turn-${String(++id).padStart(4, '0')}`
  });
  return { service, planningContext };
}

function turnInput(expectedVersion = 0, suffix = '0001') {
  return {
    expectedVersion,
    idempotencyKey: `assistant-request-${suffix}`,
    message: '把 2026-08-24 的训练移到 2026-08-25'
  };
}

describe('assistant conversation lifecycle', () => {
  it('transitions empty to received to validated to a completed replayable receipt', async () => {
    const { service } = harness();
    const received = await service.beginTurn('user-a', turnInput());
    expect(received).toMatchObject({
      kind: 'received',
      turn: { status: 'received', expectedVersion: 0 },
      messages: [],
      summary: { pendingClarification: null }
    });
    if (received.kind !== 'received') throw new Error('expected received');

    await expect(service.authorizeCommand(
      'user-a',
      received.turn.turnId,
      movedCommand
    )).resolves.toEqual(movedCommand);
    await expect(service.finalizeTurn(
      'user-a',
      received.turn.turnId,
      successResult
    )).resolves.toEqual({ conversationVersion: 1, result: successResult });

    await expect(service.beginTurn('user-a', turnInput())).resolves.toEqual({
      kind: 'replayed',
      conversationVersion: 1,
      result: successResult
    });
    const conversation = await service.getConversation('user-a');
    expect(conversation.pendingTurn).toBeNull();
    expect(conversation.version).toBe(1);
    expect(conversation.recentReceipts).toHaveLength(1);
    expect(conversation.recentMessages.map(({ role, content }) => ({ role, content })))
      .toEqual([
        { role: 'user', content: turnInput().message },
        { role: 'assistant', content: successResult.message }
      ]);
  });

  it('finalizes fixed Provider/model/command failures directly from received state', async () => {
    for (const result of [
      providerFailure,
      {
        kind: 'assistant_unavailable',
        reason: 'model_output_invalid',
        message: '暂时无法可靠理解。',
        recoveryAction: 'retry'
      },
      {
        kind: 'command_rejected',
        reason: 'command_rejected',
        message: '这项计划修改未执行。',
        recoveryAction: 'none'
      }
    ] as const satisfies readonly AssistantTurnResult[]) {
      const { service } = harness();
      const begun = await service.beginTurn('user-a', turnInput());
      if (begun.kind !== 'received') throw new Error('expected received');
      await expect(service.finalizeTurn('user-a', begun.turn.turnId, result))
        .resolves.toEqual({ conversationVersion: 1, result });
    }
  });

  it('resumes received and validated turns with the same key and fingerprint', async () => {
    const { service } = harness();
    const first = await service.beginTurn('user-a', turnInput());
    const resumed = await service.beginTurn('user-a', turnInput());
    expect(resumed).toEqual(first);
    if (first.kind !== 'received') throw new Error('expected received');
    await service.authorizeCommand('user-a', first.turn.turnId, movedCommand);
    await expect(service.beginTurn('user-a', turnInput())).resolves.toMatchObject({
      kind: 'validated',
      turn: { status: 'validated', command: movedCommand }
    });
  });

  it('rejects key reuse, a second pending key, and a stale expected version', async () => {
    const { service } = harness();
    await service.beginTurn('user-a', turnInput());
    await expect(service.beginTurn('user-a', {
      ...turnInput(),
      message: '不同消息'
    })).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    await expect(service.beginTurn('user-a', {
      ...turnInput(),
      idempotencyKey: 'assistant-request-0002'
    })).rejects.toBeInstanceOf(AssistantConversationBusyError);

    const other = harness();
    await expect(other.service.beginTurn('user-a', turnInput(1)))
      .rejects.toBeInstanceOf(AssistantConversationVersionConflictError);
  });

  it('stores the first authorized command and fails closed on a different candidate', async () => {
    const { service } = harness();
    const begun = await service.beginTurn('user-a', turnInput());
    if (begun.kind !== 'received') throw new Error('expected received');
    await service.authorizeCommand('user-a', begun.turn.turnId, movedCommand);
    await expect(service.authorizeCommand('user-a', begun.turn.turnId, {
      ...movedCommand,
      targetDate: '2026-08-26'
    })).rejects.toBeInstanceOf(AssistantCommandMismatchError);
    await expect(service.authorizeCommand('user-a', begun.turn.turnId, movedCommand))
      .resolves.toEqual(movedCommand);
  });

  it('trims messages to 12 and receipts to 32 and stores only a safe summary', async () => {
    const { service } = harness();
    for (let index = 0; index < 33; index += 1) {
      const begun = await service.beginTurn('user-a', turnInput(index, String(index).padStart(4, '0')));
      if (begun.kind !== 'received') throw new Error('expected received');
      await service.finalizeTurn('user-a', begun.turn.turnId, index === 32
        ? {
            kind: 'clarification_required',
            missingFields: ['target_date'],
            pendingClarification: {
              intent: 'move_training_day',
              sourceDate: '2026-08-24',
              targetDate: null,
              missingFields: ['target_date']
            },
            message: '还需要确认目标日期，请补充后再试。'
          }
        : providerFailure);
    }

    const conversation = await service.getConversation('user-a');
    expect(conversation.version).toBe(33);
    expect(conversation.recentMessages).toHaveLength(12);
    expect(conversation.recentReceipts).toHaveLength(32);
    expect(conversation.recentReceipts[0]?.conversationVersion).toBe(2);
    expect(conversation.summary).toEqual({
      activeWeekStartDate: '2026-08-24',
      trainingPlanVersion: 3,
      mealPlanVersion: 7,
      lockedMealDates: ['2026-08-25', '2026-08-26'],
      pendingClarification: {
        intent: 'move_training_day',
        sourceDate: '2026-08-24',
        targetDate: null,
        missingFields: ['target_date']
      }
    });
    expect(JSON.stringify(conversation.summary)).not.toMatch(
      /weight|height|allerg|recipe|ingredient|userId/i
    );
  });

  it('retries finalization without requiring or duplicating the domain command', async () => {
    const inner = new InMemoryPlanningRepository();
    let transactionCount = 0;
    const repository: PlanningRepository = {
      read: (userId) => inner.read(userId),
      transact(userId, operation) {
        transactionCount += 1;
        if (transactionCount === 3) return Promise.reject(new Error('write interrupted'));
        return inner.transact(userId, operation);
      }
    };
    const { service } = harness(repository);
    const begun = await service.beginTurn('user-a', turnInput());
    if (begun.kind !== 'received') throw new Error('expected received');
    await service.authorizeCommand('user-a', begun.turn.turnId, movedCommand);
    const executeDomainCommand = vi.fn(() => Promise.resolve(successResult));
    const result = await executeDomainCommand();

    await expect(service.finalizeTurn('user-a', begun.turn.turnId, result))
      .rejects.toThrow('write interrupted');
    await expect(service.beginTurn('user-a', turnInput())).resolves.toMatchObject({
      kind: 'validated',
      turn: { command: movedCommand }
    });
    await expect(service.finalizeTurn('user-a', begun.turn.turnId, result))
      .resolves.toEqual({ conversationVersion: 1, result });
    expect(executeDomainCommand).toHaveBeenCalledOnce();
  });

  it('returns the stored result when finalization itself is replayed', async () => {
    const { service } = harness();
    const begun = await service.beginTurn('user-a', turnInput());
    if (begun.kind !== 'received') throw new Error('expected received');
    await service.finalizeTurn('user-a', begun.turn.turnId, providerFailure);
    await expect(service.finalizeTurn('user-a', begun.turn.turnId, successResult))
      .resolves.toEqual({ conversationVersion: 1, result: providerFailure });
  });
});
