import type {
  AssistantTurnResult,
  AssistantValidatedCommand,
  PlanningAggregateState
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

const internalFailure: AssistantTurnResult = {
  kind: 'assistant_unavailable',
  reason: 'internal_error',
  message: '助手服务暂时不可用，请稍后重试或使用结构化页面。',
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
  it('derives the finalized summary from the aggregate locked by the final transaction', async () => {
    const empty = await new InMemoryPlanningRepository().read('user-a');
    const profile = {
      kind: 'body_profile_version' as const,
      id: 'profile-race-1',
      userId: 'user-a',
      version: 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      payload: {
        ageYears: 30,
        sexCode: 0 as const,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light' as const,
        allergens: [],
        avoidFoods: [],
        dietPreferences: [],
        businessTimezone: 'Asia/Shanghai'
      }
    };
    const goal = {
      kind: 'goal_version' as const,
      id: 'goal-race-1',
      userId: 'user-a',
      version: 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      bodyProfileVersionId: profile.id,
      payload: {
        goal: 'maintain' as const,
        effectiveDate: '2026-08-20',
        targetDate: '2026-10-30'
      }
    };
    const trainingPlans = [1, 2].map((version) => ({
      kind: 'training_plan_version' as const,
      id: `training-race-${String(version)}`,
      userId: 'user-a',
      version,
      createdAt: '2026-08-20T00:00:00.000Z',
      bodyProfileVersionId: profile.id,
      goalVersionId: goal.id,
      payload: {
        weekStartDate: version === 1 ? '2026-08-17' : '2026-08-24',
        businessTimezone: 'Asia/Shanghai',
        sessions: []
      }
    }));
    const inventory = {
      kind: 'inventory_version' as const,
      id: 'inventory-race-1',
      userId: 'user-a',
      version: 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      items: []
    };
    const mealPlans = [1, 2, 3].map((version) => ({
      kind: 'meal_plan_version' as const,
      id: `meal-race-${String(version)}`,
      userId: 'user-a',
      version,
      createdAt: '2026-08-20T00:00:00.000Z',
      weekStartDate: '2026-08-24',
      bodyProfileVersionId: profile.id,
      goalVersionId: goal.id,
      trainingPlanVersionId: 'training-race-2',
      inventoryVersionId: inventory.id,
      catalogVersionId: 'catalog-race-1',
      generationPolicyVersion: 'weekly-meal-generation-v1' as const,
      supersedesVersionId: version === 1 ? null : `meal-race-${String(version - 1)}`,
      readiness: 'complete' as const,
      days: [{
        businessDate: '2026-08-26',
        dailyNutritionTargetVersionId: 'target-race-1',
        dailyMenuTemplateVersionId: 'menu-race-1',
        locked: version === 3,
        manuallyModified: false,
        meals: [],
        ingredientAmounts: [],
        nutritionTotals: {
          energyKcal: 0,
          proteinG: 0,
          fatG: 0,
          carbohydrateG: 0,
          fiberG: 0,
          saturatedFatG: 0,
          addedSugarG: 0
        },
        nutritionSourceSnapshotIds: []
      }]
    }));
    const activeTrainingPlan = trainingPlans[1];
    const activeMealPlan = mealPlans[2];
    if (activeTrainingPlan === undefined || activeMealPlan === undefined) {
      throw new Error('Expected active race fixtures');
    }
    const racedState = {
      ...empty,
      bodyProfiles: [profile],
      goals: [goal],
      trainingPlans,
      inventories: [inventory],
      mealPlans,
      activeBodyProfileVersionId: profile.id,
      activeGoalVersionId: goal.id,
      activeTrainingPlanVersionId: activeTrainingPlan.id,
      activeInventoryVersionId: inventory.id,
      activeMealPlanVersionId: activeMealPlan.id
    } as unknown as PlanningAggregateState;
    let state = empty;
    let transactionCount = 0;
    const repository: PlanningRepository = {
      read: () => Promise.resolve(structuredClone(state)),
      transact: (_userId, operation) => {
        transactionCount += 1;
        if (transactionCount === 3) {
          state = {
            ...racedState,
            assistantConversation: state.assistantConversation
          };
        }
        const transition = operation(structuredClone(state));
        state = structuredClone(transition.nextState);
        return Promise.resolve(transition.result);
      }
    };
    const service = createAssistantConversationService({
      repository,
      planning: {
        getCurrentContext: () => Promise.resolve({
          trainingPlan: null,
          mealPlan: null,
          latestVersions: { trainingPlan: 0, mealPlan: 0 }
        })
      },
      now: () => '2026-08-20T00:00:00.000Z',
      nextId: () => 'assistant-turn-race-1'
    });
    const begun = await service.beginTurn('user-a', turnInput());
    if (begun.kind !== 'received') throw new Error('Expected received turn');
    await service.authorizeCommand('user-a', begun.turn.turnId, movedCommand);

    await service.finalizeTurn('user-a', begun.turn.turnId, successResult);

    expect((await service.getConversation('user-a')).summary).toEqual({
      activeWeekStartDate: '2026-08-24',
      trainingPlanVersion: 2,
      mealPlanVersion: 3,
      lockedMealDates: ['2026-08-26'],
      pendingClarification: null
    });
  });

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
      activeWeekStartDate: null,
      trainingPlanVersion: 0,
      mealPlanVersion: 0,
      lockedMealDates: [],
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

  it('atomically refuses a received-only failure after concurrent authorization wins', async () => {
    const { service } = harness();
    const begun = await service.beginTurn('user-a', turnInput());
    if (begun.kind !== 'received') throw new Error('expected received');

    const authorization = service.authorizeCommand(
      'user-a',
      begun.turn.turnId,
      movedCommand
    );
    const failureFinalization = service.finalizeReceivedTurn(
      'user-a',
      begun.turn.turnId,
      internalFailure
    );

    await expect(authorization).resolves.toEqual(movedCommand);
    await expect(failureFinalization).resolves.toBeNull();
    await expect(service.finalizeTurn('user-a', begun.turn.turnId, successResult))
      .resolves.toEqual({ conversationVersion: 1, result: successResult });
    await expect(service.beginTurn('user-a', turnInput())).resolves.toMatchObject({
      kind: 'replayed',
      result: successResult
    });
  });
});
