import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import type {
  AssistantConversationMessage,
  AssistantConversationSummary,
  AssistantMissingField,
  AssistantTurnResult,
  AssistantValidatedCommand
} from '@fitness/domain';
import { z } from 'zod';
import {
  validateAssistantModelOutput,
  type AssistantModelValidation
} from './evidence';
import type {
  AssistantLanguageModelInput,
  AssistantLanguageModelProvider,
  AssistantModelRepairFeedback
} from './model-contract';

export type {
  AssistantLanguageModelInput,
  AssistantLanguageModelProvider,
  AssistantLanguageModelResult,
  AssistantModelRepairFeedback
} from './model-contract';

export const FITNESS_ASSISTANT_SYSTEM_PROMPT = [
  '你是健身规划助手，只能识别 move_training_day、replace_meal、resize_meal_portion 三种意图。',
  '只返回符合约定联合类型的 JSON，不要 Markdown 或解释。',
  '所有参数只能复制用户最近一条消息中的原文证据，不能推断、换算或补默认值。',
  '禁止返回 userId、工具名、URL、SQL、查询、内部 ID、热量、克数、MET、时长或任意解释字段。',
  '信息不足时返回 clarify；不支持或不安全的请求返回 reject。'
].join('\n');

const repairPrompts: Readonly<Record<AssistantModelRepairFeedback, string>> = {
  invalid_json_or_schema: '上次输出不是允许的 JSON 结构。仅按固定联合类型重新输出一次。',
  evidence_not_explicit: '上次参数缺少用户原文证据。仅复制最近用户消息中的原文证据重新输出一次。',
  unsupported_parameter: '上次输出包含不允许的字段、类型或参数值。仅按白名单结构重新输出一次。'
};

export const FITNESS_ASSISTANT_GRAPH_NODES = [
  'decide',
  'validate',
  'repair',
  'validate_repair',
  'route',
  'clarify',
  'reject',
  'execute'
] as const;

export const FITNESS_ASSISTANT_GRAPH_EDGES = [
  ['__start__', 'decide'],
  ['decide', 'validate'],
  ['validate', 'repair|route'],
  ['repair', 'validate_repair'],
  ['validate_repair', 'route'],
  ['route', 'clarify|reject|execute'],
  ['clarify', '__end__'],
  ['reject', '__end__'],
  ['execute', '__end__']
] as const;

export interface FitnessAssistantAgentInput {
  readonly latestMessage: string;
  readonly recentMessages: readonly AssistantConversationMessage[];
  readonly summary: AssistantConversationSummary;
  readonly authoritativeCommand?: AssistantValidatedCommand;
}

export interface FitnessAssistantAgentDependencies {
  readonly provider: AssistantLanguageModelProvider;
  readonly authorizeCommand: (
    command: AssistantValidatedCommand
  ) => Promise<AssistantValidatedCommand>;
  readonly executeCommand: (command: AssistantValidatedCommand) => Promise<{
    readonly command: AssistantValidatedCommand['kind'];
    readonly message: string;
  }>;
}

export interface FitnessAssistantAgent {
  invoke(input: FitnessAssistantAgentInput): Promise<AssistantTurnResult>;
}

type RouteDestination = 'clarify' | 'reject' | 'execute';
type TerminalFailure = 'model_output_invalid' | 'provider_unavailable' | null;

const AgentState = new StateSchema({
  latestMessage: z.string(),
  recentMessages: z.array(z.custom<AssistantConversationMessage>()),
  summary: z.custom<AssistantConversationSummary>(),
  authoritativeCommand: z.custom<AssistantValidatedCommand>().nullable().default(null),
  rawText: z.string().nullable().default(null),
  validation: z.custom<AssistantModelValidation>().nullable().default(null),
  repairFeedback: z.custom<AssistantModelRepairFeedback>().nullable().default(null),
  terminalFailure: z.custom<TerminalFailure>().default(null),
  routeDestination: z.custom<RouteDestination>().nullable().default(null),
  result: z.custom<AssistantTurnResult>().nullable().default(null)
});

type AgentStateValue = typeof AgentState.State;

function boundedMessages(
  recentMessages: readonly AssistantConversationMessage[],
  latestMessage: string
): AssistantLanguageModelInput['messages'] {
  const prior = recentMessages.map(({ role, content }) => ({ role, content }));
  const last = prior.at(-1);
  const withLatest = last?.role === 'user' && last.content === latestMessage
    ? prior
    : [...prior, { role: 'user' as const, content: latestMessage }];
  return withLatest.slice(-12);
}

function modelInput(
  state: AgentStateValue,
  repairAttempt: 0 | 1,
  feedback?: AssistantModelRepairFeedback
): AssistantLanguageModelInput {
  return {
    systemPrompt: FITNESS_ASSISTANT_SYSTEM_PROMPT,
    messages: boundedMessages(state.recentMessages, state.latestMessage),
    repairAttempt,
    ...(feedback === undefined ? {} : {
      repairFeedback: feedback,
      repairPrompt: `${repairPrompts[feedback]} 错误类别：${feedback}`
    })
  };
}

function missingFieldMessage(fields: readonly AssistantMissingField[]): string {
  const labels: Readonly<Record<AssistantMissingField, string>> = {
    source_date: '原训练日期',
    target_date: '目标日期',
    business_date: '业务日期',
    meal_slot: '餐次',
    dish_name: '菜品名称',
    multiplier: '份量倍率'
  };
  return `还需要确认${fields.map((field) => labels[field]).join('、')}，请补充后再试。`;
}

function unavailableResult(reason: Exclude<TerminalFailure, null>): AssistantTurnResult {
  return reason === 'provider_unavailable'
    ? {
        kind: 'assistant_unavailable',
        reason,
        message: '助手服务暂时不可用，请稍后重试或使用结构化页面。',
        recoveryAction: 'retry'
      }
    : {
        kind: 'assistant_unavailable',
        reason,
        message: '暂时无法可靠理解这条修改，请使用结构化页面完成操作。',
        recoveryAction: 'retry'
      };
}

function rejectedExecution(error: unknown): AssistantTurnResult {
  const reason = typeof error === 'object' && error !== null && 'reason' in error
    ? (error as { readonly reason?: unknown }).reason
    : null;
  if (reason === 'nutrition_constraints_infeasible') {
    return {
      kind: 'command_rejected',
      reason,
      message: '该修改无法同时满足营养、库存和安全约束。',
      recoveryAction: 'review_meal_plan_changes'
    };
  }
  return {
    kind: 'command_rejected',
    reason: 'command_rejected',
    message: '这项计划修改未执行，请返回结构化页面检查后重试。',
    recoveryAction: 'none'
  };
}

export function createFitnessAssistantAgent(
  dependencies: FitnessAssistantAgentDependencies
): FitnessAssistantAgent {
  const builder = new StateGraph(AgentState)
    .addNode('decide', async (state) => {
      if (state.authoritativeCommand !== null) {
        return {
          validation: { kind: 'command', command: state.authoritativeCommand },
          routeDestination: 'execute' as const
        };
      }
      try {
        const generated = await dependencies.provider.generateIntent(modelInput(state, 0));
        return { rawText: generated.rawText };
      } catch {
        return { terminalFailure: 'provider_unavailable' as const };
      }
    })
    .addNode('validate', (state) => {
      if (state.terminalFailure !== null || state.authoritativeCommand !== null) return {};
      if (state.rawText === null) {
        return { terminalFailure: 'model_output_invalid' as const };
      }
      const validation = validateAssistantModelOutput(state.rawText, {
        latestMessage: state.latestMessage,
        pendingClarification: state.summary.pendingClarification
      });
      return validation.kind === 'invalid'
        ? { validation, repairFeedback: validation.feedback }
        : { validation };
    })
    .addNode('repair', async (state) => {
      const feedback = state.repairFeedback;
      if (feedback === null) return { terminalFailure: 'model_output_invalid' as const };
      try {
        const generated = await dependencies.provider.generateIntent(modelInput(state, 1, feedback));
        return { rawText: generated.rawText };
      } catch {
        return { terminalFailure: 'provider_unavailable' as const };
      }
    })
    .addNode('validate_repair', (state) => {
      if (state.terminalFailure !== null) return {};
      if (state.rawText === null) {
        return { terminalFailure: 'model_output_invalid' as const };
      }
      const validation = validateAssistantModelOutput(state.rawText, {
        latestMessage: state.latestMessage,
        pendingClarification: state.summary.pendingClarification
      });
      return validation.kind === 'invalid'
        ? { validation, terminalFailure: 'model_output_invalid' as const }
        : { validation };
    })
    .addNode('route', (state) => {
      if (state.terminalFailure !== null) return { routeDestination: 'reject' as const };
      if (state.validation?.kind === 'command') return { routeDestination: 'execute' as const };
      if (state.validation?.kind === 'clarify') return { routeDestination: 'clarify' as const };
      return { routeDestination: 'reject' as const };
    })
    .addNode('clarify', (state) => {
      const validation = state.validation;
      if (validation?.kind !== 'clarify') {
        return { result: unavailableResult('model_output_invalid') };
      }
      return {
        result: {
          kind: 'clarification_required' as const,
          missingFields: validation.missingFields,
          pendingClarification: validation.pendingClarification,
          message: missingFieldMessage(validation.missingFields)
        }
      };
    })
    .addNode('reject', (state) => {
      if (state.terminalFailure !== null) {
        return { result: unavailableResult(state.terminalFailure) };
      }
      const validation = state.validation;
      if (validation?.kind !== 'reject') {
        return { result: unavailableResult('model_output_invalid') };
      }
      return {
        result: validation.reason === 'unsafe_or_prohibited'
          ? {
              kind: 'request_rejected' as const,
              reason: validation.reason,
              message: '该请求超出健康健身规划助手的安全范围。'
            }
          : {
              kind: 'request_rejected' as const,
              reason: validation.reason,
              message: '目前仅支持移动训练日、替换菜品和调整餐量。'
            }
      };
    })
    .addNode('execute', async (state) => {
      const validation = state.validation;
      if (validation?.kind !== 'command') {
        return { result: unavailableResult('model_output_invalid') };
      }
      try {
        const authoritative = state.authoritativeCommand
          ?? await dependencies.authorizeCommand(validation.command);
        const executed = await dependencies.executeCommand(authoritative);
        return {
          result: {
            kind: 'command_executed' as const,
            command: executed.command,
            message: executed.message,
            recoveryAction: 'none' as const
          }
        };
      } catch (error: unknown) {
        return { result: rejectedExecution(error) };
      }
    });

  builder.addEdge(START, 'decide');
  builder.addEdge('decide', 'validate');
  builder.addConditionalEdges(
    'validate',
    (state) => state.validation?.kind === 'invalid' && state.terminalFailure === null
      ? 'repair'
      : 'route',
    ['repair', 'route']
  );
  builder.addEdge('repair', 'validate_repair');
  builder.addEdge('validate_repair', 'route');
  builder.addConditionalEdges(
    'route',
    (state) => state.routeDestination ?? 'reject',
    ['clarify', 'reject', 'execute']
  );
  builder.addEdge('clarify', END);
  builder.addEdge('reject', END);
  builder.addEdge('execute', END);
  const graph = builder.compile({ name: 'fitness-bounded-assistant' });

  return {
    async invoke(input) {
      const state = await graph.invoke({
        latestMessage: input.latestMessage,
        recentMessages: [...input.recentMessages],
        summary: input.summary,
        authoritativeCommand: input.authoritativeCommand ?? null
      });
      return state.result ?? unavailableResult('model_output_invalid');
    }
  };
}
