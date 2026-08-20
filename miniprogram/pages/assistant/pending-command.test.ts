import { describe, expect, it, vi } from 'vitest';
import {
  createPendingAssistantCommand,
  parsePendingAssistantCommand,
  pendingAssistantCommandMatches,
  pendingAssistantCommandStorageKey,
  selectPendingAssistantCommand
} from './pending-command';

const literal = {
  expectedVersion: 4,
  idempotencyKey: 'assistant-message-001',
  message: '把 2026-08-21 的训练移到 2026-08-22'
} as const;

describe('pending assistant command', () => {
  it('round-trips only the exact public send envelope', () => {
    const pending = createPendingAssistantCommand(literal);

    expect(parsePendingAssistantCommand(JSON.parse(JSON.stringify(pending))))
      .toEqual(literal);
    expect(Object.keys(pending).sort()).toEqual([
      'expectedVersion', 'idempotencyKey', 'message'
    ]);
    expect(pendingAssistantCommandStorageKey).toBe('fitness.pendingAssistantCommand.v1');
  });

  it('rejects extra identity, model, history, role, and tool fields', () => {
    for (const extra of [
      { userId: 'attacker' }, { provider: 'deepseek' }, { model: 'hidden' },
      { history: [] }, { role: 'system' }, { tool: 'arbitrary' }
    ]) {
      expect(parsePendingAssistantCommand({ ...literal, ...extra })).toBeUndefined();
    }
  });

  it('reuses the exact key only for the same version and normalized message', () => {
    const nextKey = vi.fn(() => 'assistant-message-002');

    const reused = selectPendingAssistantCommand({
      expectedVersion: 4,
      message: `  ${literal.message}  `,
      pending: literal,
      nextKey
    });
    const changed = selectPendingAssistantCommand({
      expectedVersion: 5,
      message: literal.message,
      pending: literal,
      nextKey
    });

    expect(reused).toEqual({ pending: literal, reused: true });
    expect(changed).toEqual({
      pending: { ...literal, expectedVersion: 5, idempotencyKey: 'assistant-message-002' },
      reused: false
    });
    expect(nextKey).toHaveBeenCalledTimes(1);
  });

  it('matches a server pending turn only when every envelope field is identical', () => {
    expect(pendingAssistantCommandMatches(literal, literal)).toBe(true);
    expect(pendingAssistantCommandMatches(literal, { ...literal, expectedVersion: 3 }))
      .toBe(false);
    expect(pendingAssistantCommandMatches(literal, { ...literal, message: '不同请求' }))
      .toBe(false);
    expect(pendingAssistantCommandMatches(literal, {
      ...literal, idempotencyKey: 'assistant-message-other'
    })).toBe(false);
  });
});
