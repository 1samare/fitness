import { describe, expect, test } from 'vitest';
import type { PlanningAggregateState } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  AccountCapacityExceededError,
  PLANNING_AGGREGATE_MAX_UTF8_BYTES,
  assertPlanningAggregateCapacity,
  assertPlanningAggregateCapacityTransition,
  planningAggregateUtf8Bytes
} from './planning-aggregate-capacity';

describe('planning aggregate capacity', () => {
  test('counts UTF-8 bytes rather than JavaScript code units', async () => {
    const empty = await new InMemoryPlanningRepository().read('user-a');
    const state = {
      ...empty,
      assistantConversation: {
        ...empty.assistantConversation,
        version: 1,
        recentMessages: [{
          turnId: 'turn-1',
          role: 'user' as const,
          content: '健身',
          createdAt: '2026-08-20T00:00:00.000Z'
        }]
      }
    } satisfies PlanningAggregateState;

    expect(planningAggregateUtf8Bytes(state)).toBe(
      new TextEncoder().encode(JSON.stringify(state)).byteLength
    );
    expect(planningAggregateUtf8Bytes(state)).toBeGreaterThan(JSON.stringify(state).length);
  });

  test('accepts the exact limit and rejects one additional UTF-8 byte', async () => {
    const empty = await new InMemoryPlanningRepository().read('user-a');
    const baseBytes = planningAggregateUtf8Bytes(empty);
    const atLimit = {
      ...empty,
      assistantConversation: {
        ...empty.assistantConversation,
        recentMessages: [{
          turnId: 'turn-capacity',
          role: 'user' as const,
          content: '',
          createdAt: '2026-08-20T00:00:00.000Z'
        }]
      }
    } satisfies PlanningAggregateState;
    const messageOverhead = planningAggregateUtf8Bytes(atLimit) - baseBytes;
    const atLimitMessage = atLimit.assistantConversation.recentMessages[0];
    if (atLimitMessage === undefined) throw new Error('Expected capacity message');
    const exact = {
      ...atLimit,
      assistantConversation: {
        ...atLimit.assistantConversation,
        recentMessages: [{
          ...atLimitMessage,
          content: 'a'.repeat(
            PLANNING_AGGREGATE_MAX_UTF8_BYTES - baseBytes - messageOverhead
          )
        }]
      }
    } satisfies PlanningAggregateState;
    const exactMessage = exact.assistantConversation.recentMessages[0];
    if (exactMessage === undefined) throw new Error('Expected exact capacity message');
    const over = {
      ...exact,
      assistantConversation: {
        ...exact.assistantConversation,
        recentMessages: [{
          ...exactMessage,
          content: `${exactMessage.content}a`
        }]
      }
    } satisfies PlanningAggregateState;

    expect(planningAggregateUtf8Bytes(exact)).toBe(PLANNING_AGGREGATE_MAX_UTF8_BYTES);
    expect(() => { assertPlanningAggregateCapacity(exact); }).not.toThrow();
    expect(() => { assertPlanningAggregateCapacity(over); })
      .toThrow(AccountCapacityExceededError);
  });

  test('rejects every transition whose next aggregate exceeds the limit', async () => {
    const empty = await new InMemoryPlanningRepository().read('user-a');
    const oversized = {
      ...empty,
      assistantConversation: {
        ...empty.assistantConversation,
        recentMessages: [{
          turnId: 'oversized-turn',
          role: 'user' as const,
          content: 'a'.repeat(PLANNING_AGGREGATE_MAX_UTF8_BYTES),
          createdAt: '2026-08-20T00:00:00.000Z'
        }]
      }
    } satisfies PlanningAggregateState;

    expect(() => { assertPlanningAggregateCapacityTransition(empty, oversized); })
      .toThrow(AccountCapacityExceededError);
  });
});
