import type {
  AssistantConversationMessage,
  AssistantConversationSummary,
  AssistantValidatedCommand
} from '@fitness/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  FITNESS_ASSISTANT_GRAPH_EDGES,
  FITNESS_ASSISTANT_GRAPH_NODES,
  createFitnessAssistantAgent,
  type AssistantLanguageModelInput,
  type AssistantLanguageModelProvider
} from './single-agent';

const summary: AssistantConversationSummary = {
  activeWeekStartDate: '2026-08-24',
  trainingPlanVersion: 2,
  mealPlanVersion: 4,
  lockedMealDates: [],
  pendingClarification: null
};

const requestId = 'assistant-turn-0001-model';

function providerWith(...results: Array<string | Error>): AssistantLanguageModelProvider & {
  readonly inputs: AssistantLanguageModelInput[];
} {
  const inputs: AssistantLanguageModelInput[] = [];
  return {
    inputs,
    generateIntent(input) {
      inputs.push(input);
      const result = results.shift();
      if (result instanceof Error) return Promise.reject(result);
      if (result === undefined) return Promise.reject(new Error('missing fixture result'));
      return Promise.resolve({ rawText: result });
    }
  };
}

function createInvocationDependencies() {
  const authorizeCommand = vi.fn((command: AssistantValidatedCommand) => Promise.resolve(command));
  const executeCommand = vi.fn((command: AssistantValidatedCommand) => Promise.resolve({
    command: command.kind,
    message: `executed:${command.kind}`
  }));
  return { authorizeCommand, executeCommand };
}

describe('createFitnessAssistantAgent', () => {
  it('uses one finite compiled graph with only the approved nodes and edges', () => {
    expect(FITNESS_ASSISTANT_GRAPH_NODES).toEqual([
      'decide',
      'validate',
      'repair',
      'validate_repair',
      'route',
      'clarify',
      'reject',
      'execute'
    ]);
    expect(FITNESS_ASSISTANT_GRAPH_EDGES).toEqual([
      ['__start__', 'decide'],
      ['decide', 'validate'],
      ['validate', 'repair|route'],
      ['repair', 'validate_repair'],
      ['validate_repair', 'route'],
      ['route', 'clarify|reject|execute'],
      ['clarify', '__end__'],
      ['reject', '__end__'],
      ['execute', '__end__']
    ]);
  });

  it('passes at most the latest 12 messages and executes a validated command', async () => {
    const provider = providerWith(JSON.stringify({
      kind: 'command',
      intent: 'move_training_day',
      evidence: {
        sourceDateText: '2026-08-24',
        targetDateText: '2026-08-25'
      }
    }));
    const dependencies = createInvocationDependencies();
    const agent = createFitnessAssistantAgent({ provider });
    const recentMessages: AssistantConversationMessage[] = Array.from(
      { length: 20 },
      (_unused, index) => ({
        turnId: `turn-${String(index)}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${String(index)}`,
        createdAt: `2026-08-20T00:00:${String(index).padStart(2, '0')}.000Z`
      })
    );

    await expect(agent.invoke({
      requestId,
      latestMessage: '把 2026-08-24 的训练移到 2026-08-25',
      recentMessages,
      summary,
      ...dependencies
    })).resolves.toEqual({
      kind: 'command_executed',
      command: 'move_training_day',
      message: 'executed:move_training_day',
      recoveryAction: 'none'
    });
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.messages).toHaveLength(12);
    expect(provider.inputs[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '把 2026-08-24 的训练移到 2026-08-25'
    });
    expect(dependencies.authorizeCommand).toHaveBeenCalledOnce();
    expect(dependencies.executeCommand).toHaveBeenCalledOnce();
  });

  it('makes exactly one controlled repair request after the first invalid output', async () => {
    const provider = providerWith(
      '{not json',
      JSON.stringify({
        kind: 'command',
        intent: 'move_training_day',
        evidence: {
          sourceDateText: '2026-08-24',
          targetDateText: '2026-08-25'
        }
      })
    );
    const dependencies = createInvocationDependencies();
    const agent = createFitnessAssistantAgent({ provider });

    await expect(agent.invoke({
      requestId,
      latestMessage: '把 2026-08-24 的训练移到 2026-08-25',
      recentMessages: [],
      summary,
      ...dependencies
    })).resolves.toMatchObject({ kind: 'command_executed' });
    expect(provider.inputs).toHaveLength(2);
    expect(provider.inputs[1]).toMatchObject({
      repairAttempt: 1,
      repairFeedback: 'invalid_json_or_schema'
    });
    expect(provider.inputs[1]?.repairPrompt).toContain('invalid_json_or_schema');
  });

  it('fails closed after the repaired output is invalid and never calls a tool', async () => {
    const provider = providerWith('{bad', '{still bad');
    const dependencies = createInvocationDependencies();
    const agent = createFitnessAssistantAgent({ provider });

    await expect(agent.invoke({
      requestId,
      latestMessage: '把训练改一下',
      recentMessages: [],
      summary,
      ...dependencies
    })).resolves.toEqual({
      kind: 'assistant_unavailable',
      reason: 'model_output_invalid',
      message: '暂时无法可靠理解这条修改，请使用结构化页面完成操作。',
      recoveryAction: 'retry'
    });
    expect(provider.inputs).toHaveLength(2);
    expect(dependencies.authorizeCommand).not.toHaveBeenCalled();
    expect(dependencies.executeCommand).not.toHaveBeenCalled();
  });

  it('maps Provider failure to a fixed result without exposing the supplier error', async () => {
    const provider = providerWith(new Error('secret supplier response'));
    const dependencies = createInvocationDependencies();
    const agent = createFitnessAssistantAgent({ provider });

    await expect(agent.invoke({
      requestId,
      latestMessage: '把训练改一下',
      recentMessages: [],
      summary,
      ...dependencies
    })).resolves.toEqual({
      kind: 'assistant_unavailable',
      reason: 'provider_unavailable',
      message: '助手服务暂时不可用，请稍后重试或使用结构化页面。',
      recoveryAction: 'retry'
    });
    expect(dependencies.authorizeCommand).not.toHaveBeenCalled();
    expect(dependencies.executeCommand).not.toHaveBeenCalled();
  });

  it('executes a persisted authoritative command with zero model calls', async () => {
    const provider = providerWith();
    const dependencies = createInvocationDependencies();
    const authoritativeCommand: AssistantValidatedCommand = {
      kind: 'resize_meal_portion',
      businessDate: '2026-08-26',
      slot: 'dinner',
      multiplier: 1.1
    };
    const agent = createFitnessAssistantAgent({ provider });

    await expect(agent.invoke({
      requestId,
      latestMessage: 'ignored during recovery',
      recentMessages: [],
      summary,
      authoritativeCommand,
      ...dependencies
    })).resolves.toEqual({
      kind: 'command_executed',
      command: 'resize_meal_portion',
      message: 'executed:resize_meal_portion',
      recoveryAction: 'none'
    });
    expect(provider.inputs).toHaveLength(0);
    expect(dependencies.authorizeCommand).not.toHaveBeenCalled();
    expect(dependencies.executeCommand).toHaveBeenCalledWith(authoritativeCommand);
  });

  it('executes only the authoritative command returned by authorization', async () => {
    const provider = providerWith(JSON.stringify({
      kind: 'command',
      intent: 'resize_meal_portion',
      evidence: {
        businessDateText: '2026-08-26',
        mealSlotText: '午饭',
        multiplierText: '110%'
      }
    }));
    const dependencies = createInvocationDependencies();
    const authorized: AssistantValidatedCommand = {
      kind: 'resize_meal_portion',
      businessDate: '2026-08-26',
      slot: 'lunch',
      multiplier: 1.05
    };
    dependencies.authorizeCommand.mockResolvedValueOnce(authorized);
    const agent = createFitnessAssistantAgent({ provider });

    await agent.invoke({
      requestId,
      latestMessage: '把 2026-08-26 午饭调成 110%',
      recentMessages: [],
      summary,
      ...dependencies
    });
    expect(dependencies.executeCommand).toHaveBeenCalledWith(authorized);
  });

  it('returns deterministic clarification and rejection results', async () => {
    const clarifyProvider = providerWith(JSON.stringify({
      kind: 'clarify',
      intent: 'move_training_day',
      missingFields: ['target_date']
    }));
    const clarifyDependencies = createInvocationDependencies();
    const clarifyAgent = createFitnessAssistantAgent({ provider: clarifyProvider });
    await expect(clarifyAgent.invoke({
      requestId,
      latestMessage: '把 2026-08-24 的训练挪一下',
      recentMessages: [],
      summary,
      ...clarifyDependencies
    })).resolves.toEqual({
      kind: 'clarification_required',
      missingFields: ['target_date'],
      pendingClarification: {
        intent: 'move_training_day',
        sourceDate: '2026-08-24',
        targetDate: null,
        missingFields: ['target_date']
      },
      message: '还需要确认目标日期，请补充后再试。'
    });

    const rejectProvider = providerWith(JSON.stringify({
      kind: 'reject',
      reason: 'unsafe_or_prohibited'
    }));
    const rejectDependencies = createInvocationDependencies();
    const rejectAgent = createFitnessAssistantAgent({ provider: rejectProvider });
    await expect(rejectAgent.invoke({
      requestId,
      latestMessage: '给我医疗诊断',
      recentMessages: [],
      summary,
      ...rejectDependencies
    })).resolves.toEqual({
      kind: 'request_rejected',
      reason: 'unsafe_or_prohibited',
      message: '该请求超出健康健身规划助手的安全范围。'
    });
  });
});
