import 'fake-indexeddb/auto';
import type { AssistantLanguageModelProvider } from '@fitness/agent';
import { LanguageModelBackendError } from '@fitness/providers/browser';
import { afterEach, describe, expect, test } from 'vitest';
import { FitnessLocalDatabase } from '../../db/database';
import { createLocalPlanningRuntime } from '../planning/local-planning-runtime';
import { createDefaultPlanningSetupForm } from '../planning/planning-form';
import { createLocalAssistantRuntime } from './local-assistant-runtime';

const databases: FitnessLocalDatabase[] = [];
let databaseSequence = 0;

function database(): FitnessLocalDatabase {
  const value = new FitnessLocalDatabase(`assistant-runtime-${String(++databaseSequence)}`);
  databases.push(value);
  return value;
}

async function completePlanning(target: FitnessLocalDatabase) {
  let sequence = 0;
  const planning = createLocalPlanningRuntime({
    database: target,
    now: () => '2026-08-26T08:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    nextIdempotencyKey: () => `planning-command-${String(++sequence)}`
  });
  await planning.initialize();
  await planning.confirmTestBoundary();
  const form = createDefaultPlanningSetupForm('2026-08-31');
  await planning.submitSetup({
    ...form,
    goal: 'muscle_gain',
    trainingDays: form.trainingDays.map((day, index) => (
      index === 0 || index === 2
        ? { ...day, enabled: true, sessionCode: '02054', durationMinutes: '60' }
        : day
    ))
  });
  return planning;
}

function moveProvider(): AssistantLanguageModelProvider {
  return {
    generateIntent: () => Promise.resolve({
      rawText: JSON.stringify({
        kind: 'command',
        intent: 'move_training_day',
        evidence: {
          sourceDateText: '2026-08-31',
          targetDateText: '2026-09-01'
        }
      }),
      requestId: 'model-request-001'
    })
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (target) => {
    target.close();
    await target.delete();
  }));
});

describe('local assistant runtime', () => {
  test('persists the bounded conversation and executes a validated move command', async () => {
    const target = database();
    const planning = await completePlanning(target);
    let sequence = 0;
    const assistant = createLocalAssistantRuntime({
      database: target,
      provider: moveProvider(),
      now: () => '2026-08-26T08:00:00.000Z',
      nextId: (prefix) => `assistant-${prefix}-${String(++sequence)}`,
      nextIdempotencyKey: () => `assistant-command-${String(++sequence)}`
    });
    await assistant.initialize();

    const completed = await assistant.sendMessage(
      '把 2026-08-31 的训练移到 2026-09-01'
    );
    await planning.refresh();

    expect(completed.result).toMatchObject({
      kind: 'command_executed',
      command: 'move_training_day'
    });
    expect(completed.conversation.recentMessages).toHaveLength(2);
    expect(planning.snapshot.context.trainingPlan?.payload.sessions.map((session) => (
      session.businessDate
    ))).toEqual(['2026-09-01', '2026-09-02']);
  });

  test('finalizes a safe fallback and leaves planning unchanged when the Provider is unavailable', async () => {
    const target = database();
    const planning = await completePlanning(target);
    const before = planning.snapshot.context.trainingPlan;
    const provider: AssistantLanguageModelProvider = {
      generateIntent: () => Promise.reject(
        new LanguageModelBackendError('transport_unavailable', true)
      )
    };
    let sequence = 0;
    const assistant = createLocalAssistantRuntime({
      database: target,
      provider,
      now: () => '2026-08-26T08:00:00.000Z',
      nextId: (prefix) => `assistant-${prefix}-${String(++sequence)}`,
      nextIdempotencyKey: () => `assistant-failure-${String(++sequence)}`
    });
    await assistant.initialize();

    const completed = await assistant.sendMessage(
      '把 2026-08-31 的训练移到 2026-09-01'
    );
    await planning.refresh();

    expect(completed.result).toMatchObject({
      kind: 'assistant_unavailable',
      recoveryAction: 'retry'
    });
    expect(completed.conversation.pendingTurn).toBeNull();
    expect(planning.snapshot.context.trainingPlan).toEqual(before);
  });
});
