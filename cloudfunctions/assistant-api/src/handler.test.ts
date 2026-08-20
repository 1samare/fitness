import {
  AccountDeletionPendingError,
  AssistantConversationBusyError,
  AssistantConversationVersionConflictError,
  IdempotencyKeyReuseError,
  type AssistantConversationService,
  type BeginAssistantTurnResult,
  type PlanningAssistantCommandService
} from '@fitness/application';
import type { FitnessAssistantAgent } from '@fitness/agent';
import {
  emptyAssistantConversationState,
  type AssistantTurnResult,
  type AssistantValidatedCommand
} from '@fitness/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  createAssistantApiHandler,
  type AssistantApiHandlerDependencies
} from './handler';

const command: AssistantValidatedCommand = {
  kind: 'move_training_day',
  sourceDate: '2026-08-24',
  targetDate: '2026-08-25'
};

const executed: AssistantTurnResult = {
  kind: 'command_executed',
  command: 'move_training_day',
  message: '训练日已移动。',
  recoveryAction: 'none'
};

const receivedTurn = {
  status: 'received' as const,
  turnId: 'assistant-turn-0001',
  idempotencyKey: 'assistant-request-0001',
  requestFingerprint: `v2:sha256:${'a'.repeat(64)}`,
  expectedVersion: 0,
  message: '把 2026-08-24 的训练移到 2026-08-25',
  startedAt: '2026-08-20T00:00:00.000Z'
};

function dependencies(beginResult?: BeginAssistantTurnResult) {
  const state = emptyAssistantConversationState();
  const fallbackBeginResult: BeginAssistantTurnResult = {
    kind: 'received',
    turn: receivedTurn,
    messages: [],
    summary: state.summary
  };
  const getConversation = vi.fn((_userId: string) => {
    void _userId;
    return Promise.resolve(state);
  });
  const beginTurn = vi.fn((_userId: string) => {
    void _userId;
    return Promise.resolve(beginResult ?? fallbackBeginResult);
  });
  const authorizeCommand = vi.fn((
    _userId: string,
    _turnId: string,
    candidate: AssistantValidatedCommand
  ) => Promise.resolve(candidate));
  const finalizeTurn = vi.fn((
    _userId: string,
    _turnId: string,
    result: AssistantTurnResult
  ) => Promise.resolve({
      conversationVersion: 1,
      result
    }));
  const finalizeReceivedTurn = vi.fn((
    _userId: string,
    _turnId: string,
    result: AssistantTurnResult
  ) => {
    void _userId;
    void _turnId;
    void result;
    return Promise.resolve(null);
  });
  const conversation: AssistantConversationService = {
    getConversation,
    beginTurn,
    authorizeCommand,
    finalizeTurn,
    finalizeReceivedTurn
  };
  const execute = vi.fn((
    _userId: string,
    _command: AssistantValidatedCommand,
    _idempotencyKey: string
  ) => {
    void _userId;
    void _command;
    void _idempotencyKey;
    return Promise.resolve({
      command: command.kind,
      message: executed.message
    });
  });
  const commands: PlanningAssistantCommandService = {
    execute
  };
  const invokeImplementation: FitnessAssistantAgent['invoke'] = async (input) => {
    const authoritative = input.authoritativeCommand
      ?? await input.authorizeCommand(command);
    const result = await input.executeCommand(authoritative);
    return {
      kind: 'command_executed',
      command: result.command,
      message: result.message,
      recoveryAction: 'none'
    };
  };
  const invoke = vi.fn(invokeImplementation);
  const agent: FitnessAssistantAgent = {
    invoke
  };
  return {
    conversation,
    commands,
    agent,
    getConversation,
    beginTurn,
    authorizeCommand,
    finalizeTurn,
    finalizeReceivedTurn,
    execute,
    invoke
  } satisfies AssistantApiHandlerDependencies & Record<string, unknown>;
}

const sendRequest = {
  action: 'sendAssistantMessage',
  payload: {
    expectedVersion: 0,
    idempotencyKey: 'assistant-request-0001',
    message: '把 2026-08-24 的训练移到 2026-08-25'
  }
} as const;

describe('assistant API handler', () => {
  it('strictly rejects client identity or orchestration and requires trusted identity', async () => {
    const deps = dependencies();
    const handler = createAssistantApiHandler(deps);
    await expect(handler({ ...sendRequest, userId: 'attacker' }, { userId: 'trusted' }))
      .resolves.toMatchObject({ success: false, error: { code: 'invalid_request' } });
    await expect(handler(sendRequest)).resolves.toEqual({
      success: false,
      error: {
        code: 'unauthenticated',
        message: '需要可信的微信用户身份。',
        recoveryAction: 'retry'
      }
    });
    expect(deps.beginTurn).not.toHaveBeenCalled();
  });

  it('returns only the public conversation projection', async () => {
    const deps = dependencies();
    deps.getConversation.mockResolvedValueOnce({
      ...emptyAssistantConversationState(),
      version: 4,
      pendingTurn: { ...receivedTurn, expectedVersion: 4 }
    });
    const response = await createAssistantApiHandler(deps)(
      { action: 'getAssistantConversation' },
      { userId: 'trusted-user' }
    );
    expect(response).toEqual({
      success: true,
      data: {
        kind: 'assistant_conversation',
        conversationVersion: 4,
        messages: [],
        pendingTurn: {
          expectedVersion: 4,
          idempotencyKey: receivedTurn.idempotencyKey,
          message: receivedTurn.message
        },
        supportedCommands: [
          'move_training_day',
          'replace_meal',
          'resize_meal_portion'
        ]
      }
    });
    expect(JSON.stringify(response)).not.toMatch(/fingerprint|sourceDate|targetDate|userId/i);
  });

  it('binds authorization and the domain idempotency key to trusted turn state', async () => {
    const deps = dependencies();
    const response = await createAssistantApiHandler(deps)(sendRequest, {
      userId: 'trusted-user'
    });
    expect(response).toEqual({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        conversationVersion: 1,
        result: executed
      }
    });
    expect(deps.invoke).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'assistant-turn-0001-model',
      latestMessage: receivedTurn.message
    }));
    expect(deps.authorizeCommand).toHaveBeenCalledWith(
      'trusted-user',
      receivedTurn.turnId,
      command
    );
    expect(deps.execute).toHaveBeenCalledWith(
      'trusted-user',
      command,
      'assistant-domain-assistant-turn-0001'
    );
    expect(deps.finalizeTurn).toHaveBeenCalledWith(
      'trusted-user',
      receivedTurn.turnId,
      executed
    );
  });

  it('resumes a validated command without model authorization and replays completed receipts', async () => {
    const validatedDeps = dependencies({
      kind: 'validated',
      turn: { ...receivedTurn, status: 'validated', command }
    });
    await createAssistantApiHandler(validatedDeps)(sendRequest, { userId: 'trusted-user' });
    expect(validatedDeps.invoke).toHaveBeenCalledWith(expect.objectContaining({
      authoritativeCommand: command
    }));
    expect(validatedDeps.authorizeCommand).not.toHaveBeenCalled();
    expect(validatedDeps.execute).toHaveBeenCalledOnce();

    const replayedDeps = dependencies({
      kind: 'replayed',
      conversationVersion: 3,
      result: executed
    });
    await expect(createAssistantApiHandler(replayedDeps)(sendRequest, {
      userId: 'trusted-user'
    })).resolves.toEqual({
      success: true,
      data: {
        kind: 'assistant_turn_completed',
        conversationVersion: 3,
        result: executed
      }
    });
    expect(replayedDeps.invoke).not.toHaveBeenCalled();
    expect(replayedDeps.finalizeTurn).not.toHaveBeenCalled();
  });

  it('returns a fixed retryable error without finalizing an unexpected Agent exception', async () => {
    const deps = dependencies();
    deps.invoke.mockRejectedValueOnce(new Error('secret stack and body'));
    const response = await createAssistantApiHandler(deps)(sendRequest, {
      userId: 'trusted-user'
    });
    expect(response).toEqual({
      success: false,
      error: {
        code: 'internal_error',
        message: '助手服务暂时不可用，请稍后重试。',
        recoveryAction: 'retry'
      }
    });
    expect(deps.finalizeTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toMatch(/secret|stack|body/i);
  });

  it('replays one validated domain command after a committed response is lost', async () => {
    const deps = dependencies();
    deps.beginTurn
      .mockResolvedValueOnce({
        kind: 'received',
        turn: receivedTurn,
        messages: [],
        summary: emptyAssistantConversationState().summary
      })
      .mockResolvedValueOnce({
        kind: 'validated',
        turn: { ...receivedTurn, status: 'validated', command }
      });
    let committedWrites = 0;
    deps.execute
      .mockImplementationOnce(() => {
        committedWrites += 1;
        return Promise.reject(new Error('response lost after commit'));
      })
      .mockImplementationOnce(() => Promise.resolve({
        command: command.kind,
        message: executed.message
      }));
    const handler = createAssistantApiHandler(deps);

    await expect(handler(sendRequest, { userId: 'trusted-user' }))
      .resolves.toMatchObject({ success: false, error: { code: 'internal_error' } });
    expect(committedWrites).toBe(1);
    expect(deps.finalizeTurn).not.toHaveBeenCalled();

    await expect(handler(sendRequest, { userId: 'trusted-user' }))
      .resolves.toEqual({
        success: true,
        data: {
          kind: 'assistant_turn_completed',
          conversationVersion: 1,
          result: executed
        }
      });
    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(deps.execute.mock.calls.map((call) => call[2])).toEqual([
      'assistant-domain-assistant-turn-0001',
      'assistant-domain-assistant-turn-0001'
    ]);
    expect(deps.authorizeCommand).toHaveBeenCalledOnce();
    expect(deps.finalizeTurn).toHaveBeenCalledOnce();
  });

  it.each([
    [new AccountDeletionPendingError(), 'account_deletion_pending'],
    [
      new AssistantConversationVersionConflictError(0, 1),
      'conversation_version_conflict'
    ],
    [new AssistantConversationBusyError(), 'conversation_busy'],
    [new IdempotencyKeyReuseError('assistant-request-0001'), 'invalid_request']
  ] as const)('maps lifecycle error %# to a fixed public response', async (error, code) => {
    const deps = dependencies();
    deps.beginTurn.mockRejectedValueOnce(error);
    const response = await createAssistantApiHandler(deps)(sendRequest, {
      userId: 'trusted-user'
    });
    expect(response).toMatchObject({
      success: false,
      error: { code, recoveryAction: 'retry' }
    });
    expect(JSON.stringify(response)).not.toContain('assistant-request-0001');
    expect(deps.invoke).not.toHaveBeenCalled();
  });
});
