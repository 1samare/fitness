import type {
  AssistantConversationMessage,
  AssistantConversationState,
  AssistantConversationSummary,
  AssistantReceivedTurn,
  AssistantTurnResult,
  AssistantValidatedCommand,
  AssistantValidatedTurn,
  LatestPlanningVersions,
  MealPlanDay,
  TrainingPlanPayload
} from '@fitness/domain';
import { requestFingerprint } from './idempotency-fingerprint';
import {
  IdempotencyKeyReuseError,
  type PlanningRepository
} from './versioned-planning';

export class AssistantConversationVersionConflictError extends Error {
  public readonly code = 'conversation_version_conflict' as const;

  public constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number
  ) {
    super(
      `Expected conversation version ${String(expectedVersion)}, but current version is ${String(actualVersion)}`
    );
    this.name = 'AssistantConversationVersionConflictError';
  }
}

export class AssistantConversationBusyError extends Error {
  public readonly code = 'conversation_busy' as const;

  public constructor() {
    super('Another assistant turn is still pending');
    this.name = 'AssistantConversationBusyError';
  }
}

export class AssistantCommandMismatchError extends Error {
  public readonly code = 'request_not_allowed' as const;

  public constructor() {
    super('A different command was already authorized for this assistant turn');
    this.name = 'AssistantCommandMismatchError';
  }
}

export class AssistantTurnNotPendingError extends Error {
  public readonly code = 'assistant_turn_not_pending' as const;

  public constructor() {
    super('The assistant turn is not pending');
    this.name = 'AssistantTurnNotPendingError';
  }
}

export interface BeginAssistantTurnInput {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly message: string;
}

export type BeginAssistantTurnResult =
  | {
      readonly kind: 'received';
      readonly turn: AssistantReceivedTurn;
      readonly messages: readonly AssistantConversationMessage[];
      readonly summary: AssistantConversationSummary;
    }
  | {
      readonly kind: 'validated';
      readonly turn: AssistantValidatedTurn;
    }
  | {
      readonly kind: 'replayed';
      readonly conversationVersion: number;
      readonly result: AssistantTurnResult;
    };

export interface AssistantPlanningContextPort {
  getCurrentContext(userId: string): Promise<{
    readonly trainingPlan: {
      readonly payload: Pick<TrainingPlanPayload, 'weekStartDate'>;
    } | null;
    readonly mealPlan: {
      readonly days: readonly Pick<
        MealPlanDay,
        'businessDate' | 'locked' | 'manuallyModified'
      >[];
    } | null;
    readonly latestVersions: Pick<LatestPlanningVersions, 'trainingPlan' | 'mealPlan'>;
  }>;
}

export interface AssistantConversationServiceDependencies {
  readonly repository: PlanningRepository;
  readonly planning: AssistantPlanningContextPort;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
}

export interface AssistantConversationService {
  getConversation(userId: string): Promise<AssistantConversationState>;
  beginTurn(userId: string, input: BeginAssistantTurnInput): Promise<BeginAssistantTurnResult>;
  authorizeCommand(
    userId: string,
    turnId: string,
    command: AssistantValidatedCommand
  ): Promise<AssistantValidatedCommand>;
  finalizeTurn(
    userId: string,
    turnId: string,
    result: AssistantTurnResult
  ): Promise<{
    readonly conversationVersion: number;
    readonly result: AssistantTurnResult;
  }>;
}

function turnFingerprint(input: BeginAssistantTurnInput): string {
  return requestFingerprint({
    expectedVersion: input.expectedVersion,
    message: input.message
  });
}

function assertSameFingerprint(
  actual: string,
  expected: string,
  idempotencyKey: string
): void {
  if (actual !== expected) throw new IdempotencyKeyReuseError(idempotencyKey);
}

function buildSummary(
  context: Awaited<ReturnType<AssistantPlanningContextPort['getCurrentContext']>>,
  result: AssistantTurnResult
): AssistantConversationSummary {
  const lockedMealDates = [...new Set(
    context.mealPlan?.days
      .filter((day) => day.locked || day.manuallyModified)
      .map((day) => day.businessDate) ?? []
  )].sort();
  return {
    activeWeekStartDate: context.trainingPlan?.payload.weekStartDate ?? null,
    trainingPlanVersion: context.latestVersions.trainingPlan,
    mealPlanVersion: context.latestVersions.mealPlan,
    lockedMealDates,
    pendingClarification: result.kind === 'clarification_required'
      ? result.pendingClarification
      : null
  };
}

export function createAssistantConversationService(
  dependencies: AssistantConversationServiceDependencies
): AssistantConversationService {
  const { repository, planning, now, nextId } = dependencies;
  return {
    async getConversation(userId) {
      return (await repository.read(userId)).assistantConversation;
    },

    async beginTurn(userId, input) {
      const expectedFingerprint = turnFingerprint(input);
      return repository.transact<BeginAssistantTurnResult>(userId, (state) => {
        const conversation = state.assistantConversation;
        const receipt = conversation.recentReceipts.find(
          (candidate) => candidate.idempotencyKey === input.idempotencyKey
        );
        if (receipt !== undefined) {
          assertSameFingerprint(
            receipt.requestFingerprint,
            expectedFingerprint,
            input.idempotencyKey
          );
          return {
            nextState: state,
            result: {
              kind: 'replayed' as const,
              conversationVersion: receipt.conversationVersion,
              result: receipt.result
            }
          };
        }

        const pending = conversation.pendingTurn;
        if (pending !== null) {
          if (pending.idempotencyKey !== input.idempotencyKey) {
            throw new AssistantConversationBusyError();
          }
          assertSameFingerprint(
            pending.requestFingerprint,
            expectedFingerprint,
            input.idempotencyKey
          );
          return {
            nextState: state,
            result: pending.status === 'validated'
              ? { kind: 'validated' as const, turn: pending }
              : {
                  kind: 'received' as const,
                  turn: pending,
                  messages: conversation.recentMessages,
                  summary: conversation.summary
                }
          };
        }

        if (input.expectedVersion !== conversation.version) {
          throw new AssistantConversationVersionConflictError(
            input.expectedVersion,
            conversation.version
          );
        }
        const turn: AssistantReceivedTurn = {
          status: 'received',
          turnId: nextId('assistant-turn'),
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: expectedFingerprint,
          expectedVersion: input.expectedVersion,
          message: input.message,
          startedAt: now()
        };
        return {
          nextState: {
            ...state,
            assistantConversation: { ...conversation, pendingTurn: turn }
          },
          result: {
            kind: 'received' as const,
            turn,
            messages: conversation.recentMessages,
            summary: conversation.summary
          }
        };
      });
    },

    async authorizeCommand(userId, turnId, command) {
      return repository.transact(userId, (state) => {
        const conversation = state.assistantConversation;
        const pending = conversation.pendingTurn;
        if (pending === null || pending.turnId !== turnId) {
          throw new AssistantTurnNotPendingError();
        }
        if (pending.status === 'validated') {
          if (requestFingerprint(pending.command) !== requestFingerprint(command)) {
            throw new AssistantCommandMismatchError();
          }
          return { nextState: state, result: pending.command };
        }
        const validated: AssistantValidatedTurn = {
          ...pending,
          status: 'validated',
          command
        };
        return {
          nextState: {
            ...state,
            assistantConversation: { ...conversation, pendingTurn: validated }
          },
          result: command
        };
      });
    },

    async finalizeTurn(userId, turnId, result) {
      const context = await planning.getCurrentContext(userId);
      const completedAt = now();
      return repository.transact(userId, (state) => {
        const conversation = state.assistantConversation;
        const existing = conversation.recentReceipts.find(
          (receipt) => receipt.turnId === turnId
        );
        if (existing !== undefined) {
          return {
            nextState: state,
            result: {
              conversationVersion: existing.conversationVersion,
              result: existing.result
            }
          };
        }
        const pending = conversation.pendingTurn;
        if (pending === null || pending.turnId !== turnId) {
          throw new AssistantTurnNotPendingError();
        }
        const conversationVersion = conversation.version + 1;
        const messages: readonly AssistantConversationMessage[] = [
          ...conversation.recentMessages,
          {
            turnId,
            role: 'user',
            content: pending.message,
            createdAt: pending.startedAt
          },
          {
            turnId,
            role: 'assistant',
            content: result.message,
            createdAt: completedAt
          }
        ];
        const receipt = {
          turnId,
          idempotencyKey: pending.idempotencyKey,
          requestFingerprint: pending.requestFingerprint,
          conversationVersion,
          completedAt,
          result
        };
        return {
          nextState: {
            ...state,
            assistantConversation: {
              version: conversationVersion,
              recentMessages: messages.slice(-12),
              summary: buildSummary(context, result),
              pendingTurn: null,
              recentReceipts: [...conversation.recentReceipts, receipt].slice(-32)
            }
          },
          result: { conversationVersion, result }
        };
      });
    }
  };
}
