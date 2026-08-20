import { describe, expect, test } from 'vitest';
import type { WriteCommandEnvelope } from '@fitness/domain';
import {
  AssistantCommandError,
  createPlanningAssistantCommandService,
  type PlanningAssistantCommandPort,
  type PlanningAssistantContext
} from './planning-assistant-commands';

const USER_ID = 'trusted-user';
const DOMAIN_KEY = 'assistant-domain-turn-0001';

function context(
  overrides: Partial<PlanningAssistantContext> = {}
): PlanningAssistantContext {
  return {
    bodyProfile: { payload: { businessTimezone: 'Asia/Shanghai' } },
    trainingPlan: {
      version: 2,
      payload: {
        weekStartDate: '2026-08-17',
        businessTimezone: 'Asia/Shanghai',
        sessions: [{
          businessDate: '2026-08-21',
          sessionCode: '02054',
          durationMinutes: 60
        }]
      }
    },
    mealPlan: { version: 3 },
    selectableRecipes: [{
      recipeTemplateVersionId: 'recipe-reviewed-1',
      dishNameZh: '番茄牛肉饭'
    }],
    latestVersions: { trainingPlan: 2, mealPlan: 3 },
    ...overrides
  };
}

function harness(options: {
  readonly context?: PlanningAssistantContext;
  readonly failure?: Error;
} = {}) {
  const calls: Array<{
    readonly operation: 'saveTrainingPlan' | 'updateMealPlanDay' | 'resizeMealPlanPortion';
    readonly userId: string;
    readonly envelope: WriteCommandEnvelope<unknown>;
  }> = [];
  const record = (
    operation: 'saveTrainingPlan' | 'updateMealPlanDay' | 'resizeMealPlanPortion',
    userId: string,
    envelope: WriteCommandEnvelope<unknown>
  ): Promise<unknown> => {
    if (options.failure !== undefined) return Promise.reject(options.failure);
    calls.push({ operation, userId, envelope });
    return Promise.resolve({});
  };
  const port: PlanningAssistantCommandPort = {
    getCurrentContext: () => Promise.resolve(options.context ?? context()),
    saveTrainingPlan: (userId, envelope) => record('saveTrainingPlan', userId, envelope),
    updateMealPlanDay: (userId, envelope) => record('updateMealPlanDay', userId, envelope),
    resizeMealPlanPortion: (userId, envelope) => (
      record('resizeMealPlanPortion', userId, envelope)
    )
  };
  return {
    calls,
    service: createPlanningAssistantCommandService({
      planning: port,
      now: () => '2026-08-20T00:00:00.000Z'
    })
  };
}

describe('planning assistant command service', () => {
  test('moves one future in-week session without changing code or duration', async () => {
    const testHarness = harness();

    const result = await testHarness.service.execute(USER_ID, {
      kind: 'move_training_day',
      sourceDate: '2026-08-21',
      targetDate: '2026-08-22'
    }, DOMAIN_KEY);

    expect(result).toEqual({
      command: 'move_training_day',
      message: '训练日已移动；后续营养目标会按既有规则重算，锁定餐单差异仍需确认。'
    });
    expect(testHarness.calls).toEqual([{
      operation: 'saveTrainingPlan',
      userId: USER_ID,
      envelope: {
        expectedVersion: 2,
        idempotencyKey: DOMAIN_KEY,
        payload: {
          weekStartDate: '2026-08-17',
          businessTimezone: 'Asia/Shanghai',
          sessions: [{
            businessDate: '2026-08-22',
            sessionCode: '02054',
            durationMinutes: 60
          }]
        }
      }
    }]);
  });

  test.each([
    ['same_training_date', '2026-08-21', '2026-08-21', context()],
    ['training_date_outside_active_week', '2026-08-21', '2026-08-24', context()],
    ['past_fact_immutable', '2026-08-20', '2026-08-21', context({
      trainingPlan: {
        version: 2,
        payload: {
          weekStartDate: '2026-08-17',
          businessTimezone: 'Asia/Shanghai',
          sessions: [{
            businessDate: '2026-08-20',
            sessionCode: '02054',
            durationMinutes: 60
          }]
        }
      }
    })],
    ['source_training_session_missing', '2026-08-22', '2026-08-23', context()],
    ['target_training_session_occupied', '2026-08-21', '2026-08-22', context({
      trainingPlan: {
        version: 2,
        payload: {
          weekStartDate: '2026-08-17',
          businessTimezone: 'Asia/Shanghai',
          sessions: [{
            businessDate: '2026-08-21',
            sessionCode: '02054',
            durationMinutes: 60
          }, {
            businessDate: '2026-08-22',
            sessionCode: '01010',
            durationMinutes: 30
          }]
        }
      }
    })]
  ] as const)(
    'rejects %s before writing a training plan',
    async (reason, sourceDate, targetDate, planningContext) => {
      const testHarness = harness({ context: planningContext });

      await expect(testHarness.service.execute(USER_ID, {
        kind: 'move_training_day',
        sourceDate,
        targetDate
      }, DOMAIN_KEY)).rejects.toMatchObject({
        code: 'assistant_command_rejected',
        reason
      });
      expect(testHarness.calls).toEqual([]);
    }
  );

  test('resolves an exact unique Chinese dish name to the server recipe ID', async () => {
    const testHarness = harness();

    await expect(testHarness.service.execute(USER_ID, {
      kind: 'replace_meal',
      businessDate: '2026-08-21',
      slot: 'lunch',
      dishNameZh: '番茄牛肉饭'
    }, DOMAIN_KEY)).resolves.toMatchObject({ command: 'replace_meal' });

    expect(testHarness.calls).toEqual([{
      operation: 'updateMealPlanDay',
      userId: USER_ID,
      envelope: {
        expectedVersion: 3,
        idempotencyKey: DOMAIN_KEY,
        payload: {
          businessDate: '2026-08-21',
          slot: 'lunch',
          recipeTemplateVersionId: 'recipe-reviewed-1'
        }
      }
    }]);
  });

  test.each([
    ['recipe_not_selectable', []],
    ['recipe_name_ambiguous', [{
      recipeTemplateVersionId: 'recipe-reviewed-1',
      dishNameZh: '番茄牛肉饭'
    }, {
      recipeTemplateVersionId: 'recipe-reviewed-2',
      dishNameZh: '番茄牛肉饭'
    }]]
  ] as const)('rejects %s before a meal write', async (reason, selectableRecipes) => {
    const testHarness = harness({ context: context({ selectableRecipes }) });

    await expect(testHarness.service.execute(USER_ID, {
      kind: 'replace_meal',
      businessDate: '2026-08-21',
      slot: 'lunch',
      dishNameZh: '番茄牛肉饭'
    }, DOMAIN_KEY)).rejects.toMatchObject({ reason });
    expect(testHarness.calls).toEqual([]);
  });

  test('forwards only the validated deterministic portion multiplier', async () => {
    const testHarness = harness();

    await expect(testHarness.service.execute(USER_ID, {
      kind: 'resize_meal_portion',
      businessDate: '2026-08-21',
      slot: 'dinner',
      multiplier: 1.15
    }, DOMAIN_KEY)).resolves.toMatchObject({ command: 'resize_meal_portion' });

    expect(testHarness.calls).toEqual([{
      operation: 'resizeMealPlanPortion',
      userId: USER_ID,
      envelope: {
        expectedVersion: 3,
        idempotencyKey: DOMAIN_KEY,
        payload: {
          businessDate: '2026-08-21',
          slot: 'dinner',
          multiplier: 1.15
        }
      }
    }]);
  });

  test('maps an underlying error to a fixed typed rejection without supplier text', async () => {
    const testHarness = harness({ failure: new Error('supplier secret response body') });

    const failure = await testHarness.service.execute(USER_ID, {
      kind: 'resize_meal_portion',
      businessDate: '2026-08-21',
      slot: 'dinner',
      multiplier: 1
    }, DOMAIN_KEY).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AssistantCommandError);
    expect(failure).toMatchObject({
      code: 'assistant_command_rejected',
      reason: 'internal_error',
      message: '计划修改未完成，请返回结构化页面重试。'
    });
    expect(JSON.stringify(failure)).not.toContain('supplier secret');
  });
});
