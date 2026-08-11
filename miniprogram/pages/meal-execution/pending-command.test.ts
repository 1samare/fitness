import { describe, expect, test, vi } from 'vitest';
import {
  planningApiRequestSchema,
  planningApiResponseSchema
} from '@fitness/contracts';
import {
  buildCandidateDecisionRequest,
  buildCompletionRequest,
  buildGenerateMealPlanRequest,
  buildInventoryRequest,
  buildLockRequest,
  buildRecipeEditRequest,
  buildRetryRequest
} from './form';
import {
  parsePendingMealCommand,
  pendingCommandDisposition,
  selectPendingMealCommand,
  type MealWriteRequest
} from './pending-command';

const recipes = [
  { recipeTemplateVersionId: 'recipe-1', dishNameZh: '测试菜品一' },
  { recipeTemplateVersionId: 'recipe-2', dishNameZh: '测试菜品二' }
] as const;

const requests = [
  buildInventoryRequest({
    rows: [{ name: '测试米饭', availableGrams: '500' }],
    expectedVersion: 1,
    idempotencyKey: 'placeholder'
  }),
  buildGenerateMealPlanRequest({
    weekStartDate: '2026-08-17',
    businessToday: '2026-08-10',
    expectedVersion: 2,
    idempotencyKey: 'placeholder'
  }),
  buildLockRequest({
    businessDate: '2026-08-18',
    businessToday: '2026-08-10',
    locked: true,
    expectedVersion: 3,
    idempotencyKey: 'placeholder'
  }),
  buildRecipeEditRequest({
    businessDate: '2026-08-18',
    businessToday: '2026-08-10',
    slot: 'dinner',
    selectedRecipeIndex: 0,
    recipeOptions: recipes,
    expectedVersion: 4,
    idempotencyKey: 'placeholder'
  }),
  buildCandidateDecisionRequest({
    candidateMealPlanVersionId: 'candidate-1',
    decision: 'keep_existing',
    expectedVersion: 5,
    idempotencyKey: 'placeholder'
  }),
  buildCompletionRequest({
    businessDate: '2026-08-18',
    businessToday: '2026-08-18',
    completedDurationMinutes: '30',
    expectedVersion: 6,
    idempotencyKey: 'placeholder'
  }),
  buildRetryRequest({
    recalculationJobId: 'job-1',
    expectedVersion: 7,
    idempotencyKey: 'placeholder'
  })
] as const;

describe('pending meal commands', () => {
  test.each([
    ['version_conflict', 'discard'],
    ['idempotency_key_reused', 'discard'],
    ['candidate_not_pending', 'discard'],
    ['candidate_diff_unavailable', 'discard'],
    ['provider_unavailable', 'retain'],
    ['nutrition_constraints_infeasible', 'retain'],
    ['internal_error', 'retain']
  ] as const)('classifies %s failures as %s', (code, expected) => {
    const response = planningApiResponseSchema.parse({
      success: false,
      error: { code, message: code }
    });

    expect(pendingCommandDisposition(response, 'meal_plan_updated')).toBe(expected);
  });

  test('classifies only the expected successful response as confirmed', () => {
    const response = planningApiResponseSchema.parse({
      success: true,
      data: { kind: 'inventory_saved', version: {
        kind: 'inventory_version', id: 'inventory-1', version: 1,
        createdAt: '2026-08-10T00:00:00.000Z',
        items: [{ foodId: 'food-1', availableGrams: 100, nutritionSnapshotId: 'snapshot-1' }]
      } }
    });

    expect(pendingCommandDisposition(response, 'inventory_saved')).toBe('confirmed');
    expect(pendingCommandDisposition(response, 'meal_plan_updated')).toBe('retain');
  });

  test.each(requests.map((request) => [request.action, request] as const))(
    'reuses the exact stored %s request when only the newly observed version changes',
    (_action, request) => {
      const nextKey = vi.fn(() => `${request.action}-key-001`);
      const first = selectPendingMealCommand({ request, pending: undefined, nextKey });
      const rebuiltWithNewVersion = planningApiRequestSchema.parse({
        ...request,
        payload: { ...request.payload, expectedVersion: request.payload.expectedVersion + 20 }
      }) as MealWriteRequest;

      const retried = selectPendingMealCommand({
        request: rebuiltWithNewVersion,
        pending: first.pending,
        nextKey
      });

      expect(retried).toEqual({ pending: first.pending, reused: true });
      expect(retried.pending.request).toEqual(first.pending.request);
      expect(nextKey).toHaveBeenCalledTimes(1);
      expect(parsePendingMealCommand(JSON.parse(JSON.stringify(first.pending)))).toEqual(first.pending);
    }
  );

  test('creates a new completion command when the user changes the actual minutes', () => {
    const first = selectPendingMealCommand({
      request: requests[5],
      pending: undefined,
      nextKey: () => 'completion-key-001'
    });
    const changed = buildCompletionRequest({
      businessDate: '2026-08-18',
      businessToday: '2026-08-18',
      completedDurationMinutes: '31',
      expectedVersion: 9,
      idempotencyKey: 'placeholder'
    });

    const second = selectPendingMealCommand({
      request: changed,
      pending: first.pending,
      nextKey: () => 'completion-key-002'
    });

    expect(second.reused).toBe(false);
    expect(second.pending.request.payload).toMatchObject({
      expectedVersion: 9,
      idempotencyKey: 'completion-key-002',
      payload: { completedDurationMinutes: 31 }
    });
  });

  test('rejects a stored envelope whose fingerprint or request was tampered with', () => {
    const selected = selectPendingMealCommand({
      request: requests[2],
      pending: undefined,
      nextKey: () => 'lock-key-001'
    });

    expect(parsePendingMealCommand({
      ...selected.pending,
      payloadFingerprint: 'tampered'
    })).toBeUndefined();
    expect(parsePendingMealCommand({
      ...selected.pending,
      request: {
        ...selected.pending.request,
        payload: { ...selected.pending.request.payload, userId: 'attacker' }
      }
    })).toBeUndefined();
  });
});
