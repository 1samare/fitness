import { describe, expect, it } from 'vitest';
import {
  buildCandidateDecisionRequest,
  buildCompletionRequest,
  buildGenerateMealPlanRequest,
  buildInventoryRequest,
  buildLockRequest,
  buildRecipeEditRequest,
  buildResolveFoodNameRequest,
  buildRetryRequest
} from './form';

describe('meal execution form request builders', () => {
  it('builds inventory writes from normalized visible names and gram values', () => {
    expect(buildInventoryRequest({
      rows: [{ name: '  测试米饭  ', availableGrams: '5000' }],
      expectedVersion: 0,
      idempotencyKey: 'inventory-ui-001'
    })).toEqual({
      action: 'saveInventory',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'inventory-ui-001',
        payload: { items: [{ name: '测试米饭', availableGrams: 5000 }] }
      }
    });
  });

  it.each([
    { rows: [{ name: ' ', availableGrams: '100' }], message: '请填写第 1 行食材名称' },
    {
      rows: [
        { name: '测试米饭', availableGrams: '100' },
        { name: '  测试米饭 ', availableGrams: '200' }
      ],
      message: '食材名称不能重复'
    },
    { rows: [{ name: '测试米饭', availableGrams: 'abc' }], message: '请输入有效克数' },
    { rows: [{ name: '测试米饭', availableGrams: '0' }], message: '克数必须大于 0' }
  ])('rejects an invalid inventory row: $message', ({ rows, message }) => {
    expect(() => buildInventoryRequest({
      rows,
      expectedVersion: 0,
      idempotencyKey: 'inventory-ui-invalid'
    })).toThrow(message);
  });

  it('resolves a visible food name without accepting an internal identifier', () => {
    expect(buildResolveFoodNameRequest('  测试米饭 ')).toEqual({
      action: 'resolveFoodName',
      payload: { name: '测试米饭' }
    });
  });

  it('builds generation and future-day lock requests with strict write envelopes', () => {
    expect(buildGenerateMealPlanRequest({
      weekStartDate: '2026-08-17',
      businessToday: '2026-08-10',
      expectedVersion: 0,
      idempotencyKey: 'meal-generate-ui-001'
    })).toEqual({
      action: 'generateWeeklyMealPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'meal-generate-ui-001',
        payload: { weekStartDate: '2026-08-17' }
      }
    });
    expect(buildLockRequest({
      businessDate: '2026-08-18',
      businessToday: '2026-08-10',
      locked: true,
      expectedVersion: 1,
      idempotencyKey: 'meal-lock-ui-001'
    })).toEqual({
      action: 'setMealPlanDayLock',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'meal-lock-ui-001',
        payload: { businessDate: '2026-08-18', locked: true }
      }
    });
  });

  it('uses only a server-provided recipe option selected by picker index', () => {
    expect(buildRecipeEditRequest({
      businessDate: '2026-08-19',
      businessToday: '2026-08-10',
      slot: 'dinner',
      selectedRecipeIndex: 1,
      recipeOptions: [
        { recipeTemplateVersionId: 'recipe-server-1', dishNameZh: '番茄鸡蛋' },
        { recipeTemplateVersionId: 'recipe-server-2', dishNameZh: '香菇鸡肉' }
      ],
      expectedVersion: 2,
      idempotencyKey: 'meal-edit-ui-001'
    })).toEqual({
      action: 'updateMealPlanDay',
      payload: {
        expectedVersion: 2,
        idempotencyKey: 'meal-edit-ui-001',
        payload: {
          businessDate: '2026-08-19',
          slot: 'dinner',
          recipeTemplateVersionId: 'recipe-server-2'
        }
      }
    });
    expect(() => buildRecipeEditRequest({
      businessDate: '2026-08-19',
      businessToday: '2026-08-10',
      slot: 'dinner',
      selectedRecipeIndex: 2,
      recipeOptions: [
        { recipeTemplateVersionId: 'recipe-server-1', dishNameZh: '番茄鸡蛋' }
      ],
      expectedVersion: 2,
      idempotencyKey: 'meal-edit-ui-invalid'
    })).toThrow('请选择服务端提供的备选菜品');
  });

  it.each(['0', '300'])('accepts completion boundary %s minutes', (completedDurationMinutes) => {
    expect(buildCompletionRequest({
      businessDate: '2026-08-10',
      businessToday: '2026-08-10',
      completedDurationMinutes,
      expectedVersion: 0,
      idempotencyKey: `completion-ui-${completedDurationMinutes}`
    })).toMatchObject({
      action: 'recordTrainingCompletion',
      payload: { payload: { completedDurationMinutes: Number(completedDurationMinutes) } }
    });
  });

  it.each([
    { businessDate: '2026-02-29', minutes: '30', message: '请选择有效业务日期' },
    { businessDate: '2026-08-11', minutes: '30', message: '不能记录未来日期' },
    { businessDate: '2026-08-10', minutes: '-1', message: '完成分钟数须为 0–300 的整数' },
    { businessDate: '2026-08-10', minutes: '301', message: '完成分钟数须为 0–300 的整数' },
    { businessDate: '2026-08-10', minutes: '1.5', message: '完成分钟数须为 0–300 的整数' }
  ])('rejects invalid completion input: $message', ({ businessDate, minutes, message }) => {
    expect(() => buildCompletionRequest({
      businessDate,
      businessToday: '2026-08-10',
      completedDurationMinutes: minutes,
      expectedVersion: 0,
      idempotencyKey: 'completion-ui-invalid'
    })).toThrow(message);
  });

  it('builds candidate decisions and retry requests from context-owned identifiers', () => {
    expect(buildCandidateDecisionRequest({
      candidateMealPlanVersionId: 'candidate-from-context',
      decision: 'keep_existing',
      expectedVersion: 0,
      idempotencyKey: 'candidate-ui-001'
    })).toEqual({
      action: 'decideMealPlanCandidate',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'candidate-ui-001',
        payload: {
          candidateMealPlanVersionId: 'candidate-from-context',
          decision: 'keep_existing'
        }
      }
    });
    expect(buildRetryRequest({
      recalculationJobId: 'job-from-response',
      expectedVersion: 1,
      idempotencyKey: 'recalculate-ui-001'
    })).toEqual({
      action: 'retryPendingRecalculation',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'recalculate-ui-001',
        payload: { recalculationJobId: 'job-from-response' }
      }
    });
    expect(() => buildCandidateDecisionRequest({
      candidateMealPlanVersionId: 'candidate-from-context',
      decision: 'replace_silently',
      expectedVersion: 0,
      idempotencyKey: 'candidate-ui-invalid'
    })).toThrow('请选择保留原餐单或覆盖锁定日');
  });
});
