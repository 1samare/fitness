import {
  createFitnessAssistantAgent,
  type AssistantLanguageModelProvider,
  type FitnessAssistantAgent,
  type FitnessAssistantAgentDependencies
} from '@fitness/agent';
import {
  createAssistantConversationService,
  createPlanningAssistantCommandService,
  AssistantConversationBusyError,
  AssistantConversationVersionConflictError,
  IdempotencyKeyReuseError,
  type AssistantConversationService,
  type PlanningRepository,
  type PlanningAssistantCommandService
} from '@fitness/application';
import {
  assistantApiRequestSchema,
  assistantApiResponseSchema,
  type AssistantApiResponse
} from '@fitness/contracts';
import type {
  AssistantConversationState,
  AssistantTurnResult
} from '@fitness/domain';

export interface TrustedAssistantRequestContext {
  readonly userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvent(event: unknown): unknown {
  const input = isRecord(event) && 'body' in event
    ? (typeof event.body === 'string' ? JSON.parse(event.body) as unknown : event.body)
    : event;
  if (!isRecord(input) || (!('userInfo' in input) && !('tcbContext' in input))) return input;
  const normalized = { ...input };
  delete normalized.userInfo;
  delete normalized.tcbContext;
  return normalized;
}

export interface AssistantMainDependencies {
  readonly resolveIdentity: (
    runtimeContext: unknown
  ) => TrustedAssistantRequestContext | undefined;
  readonly handle: (
    input: unknown,
    context?: TrustedAssistantRequestContext
  ) => Promise<AssistantApiResponse>;
}

export function createAssistantMain(dependencies: AssistantMainDependencies) {
  return async (event: unknown, runtimeContext?: unknown): Promise<AssistantApiResponse> => {
    let input: unknown;
    try {
      input = normalizeEvent(event);
    } catch {
      return assistantApiResponseSchema.parse(errorResponse(
        'invalid_request',
        '请求体不是有效 JSON。',
        'retry'
      ));
    }
    try {
      return await dependencies.handle(
        input,
        dependencies.resolveIdentity(runtimeContext)
      );
    } catch {
      return assistantApiResponseSchema.parse(errorResponse(
        'internal_error',
        '助手服务暂时不可用，请稍后重试。',
        'retry'
      ));
    }
  };
}

export interface AssistantApiHandlerDependencies {
  readonly conversation: AssistantConversationService;
  readonly commands: PlanningAssistantCommandService;
  readonly agent: FitnessAssistantAgent;
}

export interface AssistantApiCompositionDependencies {
  readonly repository: PlanningRepository;
  readonly planning: Parameters<typeof createPlanningAssistantCommandService>[0]['planning']
    & Parameters<typeof createAssistantConversationService>[0]['planning'];
  readonly provider: AssistantLanguageModelProvider;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  readonly createAgent?: ((
    dependencies: FitnessAssistantAgentDependencies
  ) => FitnessAssistantAgent) | undefined;
}

const supportedCommands: [
  'move_training_day',
  'replace_meal',
  'resize_meal_portion'
] = [
  'move_training_day',
  'replace_meal',
  'resize_meal_portion'
] as const;

function errorResponse(
  code: Extract<AssistantApiResponse, { readonly success: false }>['error']['code'],
  message: string,
  recoveryAction: Extract<AssistantApiResponse, { readonly success: false }>['error']['recoveryAction'],
  issues?: readonly { readonly path: string; readonly message: string }[]
): AssistantApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
      recoveryAction,
      ...(issues === undefined ? {} : { issues: [...issues] })
    }
  };
}

function publicConversation(
  conversation: AssistantConversationState
): AssistantApiResponse {
  const pending = conversation.pendingTurn;
  return {
    success: true,
    data: {
      kind: 'assistant_conversation',
      conversationVersion: conversation.version,
      messages: [...conversation.recentMessages],
      pendingTurn: pending === null
        ? null
        : {
            expectedVersion: pending.expectedVersion,
            idempotencyKey: pending.idempotencyKey,
            message: pending.message
          },
      supportedCommands
    }
  };
}

function completed(
  conversationVersion: number,
  result: AssistantTurnResult
): AssistantApiResponse {
  return assistantApiResponseSchema.parse({
    success: true,
    data: {
      kind: 'assistant_turn_completed',
      conversationVersion,
      result
    }
  });
}

function mappedError(error: unknown): AssistantApiResponse {
  if (error instanceof AssistantConversationVersionConflictError) {
    return errorResponse(
      error.code,
      '对话已更新，请刷新后重试。',
      'retry'
    );
  }
  if (error instanceof AssistantConversationBusyError) {
    return errorResponse(
      error.code,
      '上一条助手操作仍在处理中，请使用原请求重试。',
      'retry'
    );
  }
  if (error instanceof IdempotencyKeyReuseError) {
    return errorResponse(
      'invalid_request',
      '幂等键已用于不同的助手请求。',
      'retry'
    );
  }
  return errorResponse(
    'internal_error',
    '助手服务暂时不可用，请稍后重试。',
    'retry'
  );
}

export function createAssistantApiHandler(
  dependencies: AssistantApiHandlerDependencies
) {
  return async (
    input: unknown,
    context?: TrustedAssistantRequestContext
  ): Promise<AssistantApiResponse> => {
    const parsed = assistantApiRequestSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }));
      return assistantApiResponseSchema.parse(errorResponse(
        'invalid_request',
        '请求参数不合法。',
        'retry',
        issues
      ));
    }
    if (context === undefined) {
      return assistantApiResponseSchema.parse(errorResponse(
        'unauthenticated',
        '需要可信的微信用户身份。',
        'retry'
      ));
    }
    try {
      if (parsed.data.action === 'getAssistantConversation') {
        return assistantApiResponseSchema.parse(publicConversation(
          await dependencies.conversation.getConversation(context.userId)
        ));
      }
      const begun = await dependencies.conversation.beginTurn(
        context.userId,
        parsed.data.payload
      );
      if (begun.kind === 'replayed') {
        return assistantApiResponseSchema.parse(completed(
          begun.conversationVersion,
          begun.result
        ));
      }
      const turn = begun.turn;
      const result = await dependencies.agent.invoke({
        requestId: `${turn.turnId}-model`,
        latestMessage: turn.message,
        recentMessages: begun.kind === 'received' ? begun.messages : [],
        summary: begun.kind === 'received'
          ? begun.summary
          : (await dependencies.conversation.getConversation(context.userId)).summary,
        ...(begun.kind === 'validated'
          ? { authoritativeCommand: begun.turn.command }
          : {}),
        authorizeCommand: (candidate) => dependencies.conversation.authorizeCommand(
          context.userId,
          turn.turnId,
          candidate
        ),
        executeCommand: (authoritative) => dependencies.commands.execute(
          context.userId,
          authoritative,
          `assistant-domain-${turn.turnId}`
        )
      });
      const finalized = await dependencies.conversation.finalizeTurn(
        context.userId,
        turn.turnId,
        result
      );
      return assistantApiResponseSchema.parse(completed(
        finalized.conversationVersion,
        finalized.result
      ));
    } catch (error: unknown) {
      return assistantApiResponseSchema.parse(mappedError(error));
    }
  };
}

export function createAssistantApiComposition(
  dependencies: AssistantApiCompositionDependencies
) {
  const conversation = createAssistantConversationService({
    repository: dependencies.repository,
    planning: dependencies.planning,
    now: dependencies.now,
    nextId: dependencies.nextId
  });
  const commands = createPlanningAssistantCommandService({
    planning: dependencies.planning,
    now: dependencies.now
  });
  const agent = (dependencies.createAgent ?? createFitnessAssistantAgent)({
    provider: dependencies.provider
  });
  return createAssistantApiHandler({ conversation, commands, agent });
}
