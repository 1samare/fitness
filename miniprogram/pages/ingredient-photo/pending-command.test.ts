import { describe, expect, test, vi } from 'vitest';
import {
  createPendingIngredientPhotoCommand,
  parsePendingIngredientPhotoCommand,
  selectPendingIngredientPhotoCommand
} from './pending-command';

describe('pending ingredient photo commands', () => {
  test('stores only redacted fields and keeps grams null before confirmation submit', () => {
    const pending = createPendingIngredientPhotoCommand({
      action: 'recognizeIngredientPhoto',
      idempotencyKey: 'photo-recognize-001',
      expectedVersion: 2,
      photoId: 'photo-a',
      candidateId: null,
      expectedInventoryVersion: null,
      confirmedGrams: null
    });

    expect(pending).toEqual({
      action: 'recognizeIngredientPhoto',
      idempotencyKey: 'photo-recognize-001',
      expectedVersion: 2,
      photoId: 'photo-a',
      candidateId: null,
      expectedInventoryVersion: null,
      confirmedGrams: null
    });
    expect(JSON.stringify(pending)).not.toMatch(
      /tempFilePath|fileID|fileId|privateFileId|cloudPath|canonicalNameZh|confidence/
    );
  });

  test('rejects persisted private or display fields instead of silently retaining them', () => {
    const valid = {
      action: 'registerIngredientPhotoUpload',
      idempotencyKey: 'photo-register-001',
      expectedVersion: 1,
      photoId: 'photo-a',
      candidateId: null,
      expectedInventoryVersion: null,
      confirmedGrams: null
    } as const;

    expect(parsePendingIngredientPhotoCommand({
      ...valid, privateFileId: 'cloud://sensitive/private.jpg'
    })).toBeUndefined();
    expect(parsePendingIngredientPhotoCommand({ ...valid, cloudPath: 'private/path.jpg' }))
      .toBeUndefined();
    expect(parsePendingIngredientPhotoCommand({ ...valid, name: '审核鸡胸肉' }))
      .toBeUndefined();
    expect(parsePendingIngredientPhotoCommand({ ...valid, confidence: 0.98 }))
      .toBeUndefined();
  });

  test('persists grams only for submitted confirmation and reuses an identical command', () => {
    const nextKey = vi.fn(() => 'photo-confirm-001');
    const submitted = {
      action: 'confirmIngredientCandidate' as const,
      expectedVersion: 3,
      photoId: 'photo-a',
      candidateId: 'candidate-a',
      expectedInventoryVersion: 4,
      confirmedGrams: 125
    };
    const first = selectPendingIngredientPhotoCommand({
      command: submitted, pending: undefined, nextKey
    });
    const restored = parsePendingIngredientPhotoCommand(
      JSON.parse(JSON.stringify(first.pending))
    );
    const retry = selectPendingIngredientPhotoCommand({
      command: submitted,
      pending: restored,
      nextKey
    });

    expect(first.pending.confirmedGrams).toBe(125);
    expect(retry).toEqual({ pending: first.pending, reused: true });
    expect(retry.pending.idempotencyKey).toBe('photo-confirm-001');
    expect(retry.pending.confirmedGrams).toBe(125);
    expect(nextKey).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['photo revision', { expectedVersion: 8 }],
    ['inventory version', { expectedInventoryVersion: 9 }]
  ] as const)('creates a new key when the %s changes', (_label, changedVersion) => {
    const submitted = {
      action: 'confirmIngredientCandidate' as const,
      expectedVersion: 3,
      photoId: 'photo-a',
      candidateId: 'candidate-a',
      expectedInventoryVersion: 4,
      confirmedGrams: 125
    };
    const first = selectPendingIngredientPhotoCommand({
      command: submitted,
      pending: undefined,
      nextKey: () => 'photo-confirm-001'
    });

    const changed = selectPendingIngredientPhotoCommand({
      command: { ...submitted, ...changedVersion },
      pending: first.pending,
      nextKey: () => 'photo-confirm-002'
    });

    expect(changed.reused).toBe(false);
    expect(changed.pending.idempotencyKey).toBe('photo-confirm-002');
    expect(changed.pending).toMatchObject(changedVersion);
  });

  test('creates a new confirmation when the user explicitly submits different grams', () => {
    const first = selectPendingIngredientPhotoCommand({
      command: {
        action: 'confirmIngredientCandidate', expectedVersion: 3,
        photoId: 'photo-a', candidateId: 'candidate-a',
        expectedInventoryVersion: 4, confirmedGrams: 125
      },
      pending: undefined,
      nextKey: () => 'photo-confirm-001'
    });
    const second = selectPendingIngredientPhotoCommand({
      command: {
        action: 'confirmIngredientCandidate', expectedVersion: 3,
        photoId: 'photo-a', candidateId: 'candidate-a',
        expectedInventoryVersion: 4, confirmedGrams: 126
      },
      pending: first.pending,
      nextKey: () => 'photo-confirm-002'
    });

    expect(second.reused).toBe(false);
    expect(second.pending).toMatchObject({
      idempotencyKey: 'photo-confirm-002', confirmedGrams: 126
    });
  });
});
