import { describe, expect, test } from 'vitest';
import { planningApiRequestSchema, planningApiResponseSchema, visionProviderResponseSchema } from './index';

describe('ingredient photo contracts', () => {
  test('accepts only the four server-owned photo command shapes', () => {
    expect(planningApiRequestSchema.parse({
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'photo-create-001',
        payload: { mediaType: 'image/jpeg' }
      }
    }).action).toBe('createIngredientPhotoUpload');
    expect(planningApiRequestSchema.safeParse({
      action: 'confirmIngredientCandidate',
      payload: {
        expectedVersion: 3,
        idempotencyKey: 'photo-confirm-001',
        payload: {
          photoId: 'photo-a',
          candidateId: 'candidate-a',
          confirmedGrams: 125.5,
          expectedInventoryVersion: 0,
          userId: 'attacker'
        }
      }
    }).success).toBe(false);
  });

  test('rejects nutrition fields and more than five raw vision candidates', () => {
    const candidate = {
      providerCandidateId: 'provider-a',
      name: '鸡胸肉',
      confidence: 0.9,
      foodState: 'raw' as const
    };
    expect(visionProviderResponseSchema.safeParse({
      requestId: 'provider-request-a',
      candidates: [{ ...candidate, grams: 100 }]
    }).success).toBe(false);
    expect(visionProviderResponseSchema.safeParse({
      requestId: 'provider-request-a',
      candidates: Array.from({ length: 6 }, (_, index) => ({
        ...candidate,
        providerCandidateId: `provider-${String(index)}`
      }))
    }).success).toBe(false);
  });

  test('public photo responses reject storage and identity fields', () => {
    const response = {
      success: true,
      data: {
        kind: 'ingredient_photo_recognized',
        photo: {
          photoId: 'photo-a',
          revision: 3,
          workflowStatus: 'recognized',
          storageStatus: 'retained',
          deleteDueAt: '2026-08-19T23:00:00.000Z',
          candidates: [],
          confirmedCandidateId: null,
          inventoryVersionId: null,
          userId: 'user-a'
        }
      }
    };
    expect(planningApiResponseSchema.safeParse(response).success).toBe(false);
  });
});
