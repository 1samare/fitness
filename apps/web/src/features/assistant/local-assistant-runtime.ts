import {
  createFitnessAssistantAgent,
  type AssistantLanguageModelProvider
} from '@fitness/agent';
import {
  createAssistantConversationService,
  createMealPlanRecalculationService,
  createPlanningAssistantCommandService
} from '@fitness/application/browser';
import {
  type FitnessLocalDatabase,
  LOCAL_USER_ID
} from '../../db/database';
import { DexiePlanningRepository } from '../../db/dexie-planning-repository';
import { createLocalMealPlanningProviders } from '../meals/local-meal-providers';

export interface LocalAssistantRuntimeOptions {
  readonly database: FitnessLocalDatabase;
  readonly provider: AssistantLanguageModelProvider;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
  readonly nextIdempotencyKey?: () => string;
}

function browserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class LocalAssistantInputError extends Error {
  public readonly code = 'assistant_message_invalid' as const;

  public constructor() {
    super('Assistant message must contain between 1 and 2000 characters');
    this.name = 'LocalAssistantInputError';
  }
}

const unexpectedAgentFailure = {
  kind: 'assistant_unavailable' as const,
  reason: 'provider_unavailable' as const,
  message: '助手暂时不可用，请使用训练或餐单结构化页面继续操作。',
  recoveryAction: 'retry' as const
};

export function createLocalAssistantRuntime(options: LocalAssistantRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? browserId;
  const nextIdempotencyKey = options.nextIdempotencyKey
    ?? (() => browserId('assistant-command'));
  const repository = new DexiePlanningRepository(options.database);
  const planning = createMealPlanRecalculationService({
    repository,
    now,
    nextId,
    providers: createLocalMealPlanningProviders(options.database)
  });
  const conversation = createAssistantConversationService({
    repository,
    planning,
    now,
    nextId
  });
  const commands = createPlanningAssistantCommandService({ planning, now });
  const agent = createFitnessAssistantAgent({ provider: options.provider });
  let currentConversation: Awaited<ReturnType<typeof conversation.getConversation>> | null = null;

  async function refresh() {
    currentConversation = await conversation.getConversation(LOCAL_USER_ID);
    return currentConversation;
  }

  return {
    get conversation() {
      if (currentConversation === null) {
        throw new Error('Local assistant runtime is not initialized');
      }
      return currentConversation;
    },

    initialize: refresh,
    refresh,

    async sendMessage(message: string) {
      const normalized = message.trim();
      if (normalized.length === 0 || normalized.length > 2_000) {
        throw new LocalAssistantInputError();
      }
      const authoritativeConversation = await refresh();
      const begun = await conversation.beginTurn(LOCAL_USER_ID, {
        expectedVersion: authoritativeConversation.version,
        idempotencyKey: nextIdempotencyKey(),
        message: normalized
      });
      if (begun.kind === 'replayed') {
        return {
          conversation: await refresh(),
          result: begun.result
        };
      }

      const turn = begun.turn;
      try {
        const result = await agent.invoke({
          requestId: `${turn.turnId}-model`,
          latestMessage: turn.message,
          recentMessages: begun.kind === 'received' ? begun.messages : [],
          summary: begun.kind === 'received'
            ? begun.summary
            : (await conversation.getConversation(LOCAL_USER_ID)).summary,
          ...(begun.kind === 'validated'
            ? { authoritativeCommand: begun.turn.command }
            : {}),
          authorizeCommand: (candidate) => conversation.authorizeCommand(
            LOCAL_USER_ID,
            turn.turnId,
            candidate
          ),
          executeCommand: (command) => commands.execute(
            LOCAL_USER_ID,
            command,
            `assistant-domain-${turn.turnId}`
          )
        });
        const finalized = await conversation.finalizeTurn(
          LOCAL_USER_ID,
          turn.turnId,
          result
        );
        return {
          conversation: await refresh(),
          result: finalized.result
        };
      } catch (error: unknown) {
        const finalized = await conversation.finalizeReceivedTurn(
          LOCAL_USER_ID,
          turn.turnId,
          unexpectedAgentFailure
        ).catch(() => null);
        if (finalized !== null) {
          return {
            conversation: await refresh(),
            result: finalized.result
          };
        }
        throw error;
      }
    }
  };
}

export type LocalAssistantRuntime = ReturnType<typeof createLocalAssistantRuntime>;
