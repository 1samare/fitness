import { describe, expect, test } from 'vitest';
import { buildPlanningSetupRequests } from './form';

const validForm = {
  ageYears: '30',
  sexCode: '0',
  heightCm: '175',
  weightKg: '70',
  healthScopeConfirmed: true,
  activity: 'light',
  allergens: '花生, 虾',
  avoidFoods: '香菜',
  dietPreferences: '家常菜',
  goal: 'maintain',
  targetWeightKg: '',
  effectiveDate: '2026-08-03',
  targetDate: '2026-10-26',
  weekStartDate: '2026-08-03',
  trainingDate: '2026-08-04',
  durationMinutes: '60'
} as const;

describe('buildPlanningSetupRequests', () => {
  test('builds three versioned commands and normalizes comma-separated preferences', () => {
    const result = buildPlanningSetupRequests(validForm, {
      bodyProfile: 0,
      goal: 0,
      trainingPlan: 0
    }, {
      bodyProfile: 'profile-key-001',
      goal: 'goal-key-001',
      trainingPlan: 'training-key-001'
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.bodyProfile.payload.payload.allergens).toEqual(['花生', '虾']);
      expect(result.goal.payload.payload).toEqual({
        goal: 'maintain',
        effectiveDate: '2026-08-03',
        targetDate: '2026-10-26'
      });
      expect(result.trainingPlan.payload.payload.sessions).toEqual([{
        businessDate: '2026-08-04',
        sessionCode: '02054',
        durationMinutes: 60
      }]);
    }
  });

  test('supports an explicit no-training week', () => {
    const result = buildPlanningSetupRequests({
      ...validForm,
      trainingDate: '',
      durationMinutes: ''
    }, {
      bodyProfile: 1,
      goal: 1,
      trainingPlan: 1
    }, {
      bodyProfile: 'profile-key-002',
      goal: 'goal-key-002',
      trainingPlan: 'training-key-002'
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.trainingPlan.payload.payload.sessions).toEqual([]);
      expect(result.trainingPlan.payload.expectedVersion).toBe(1);
    }
  });

  test('rejects missing health confirmation and partial training input', () => {
    expect(buildPlanningSetupRequests({
      ...validForm,
      healthScopeConfirmed: false
    }, { bodyProfile: 0, goal: 0, trainingPlan: 0 }, {
      bodyProfile: 'profile-key-003',
      goal: 'goal-key-003',
      trainingPlan: 'training-key-003'
    })).toEqual({ kind: 'invalid', message: '请先完成健康适用范围确认。' });

    expect(buildPlanningSetupRequests({
      ...validForm,
      durationMinutes: ''
    }, { bodyProfile: 0, goal: 0, trainingPlan: 0 }, {
      bodyProfile: 'profile-key-004',
      goal: 'goal-key-004',
      trainingPlan: 'training-key-004'
    })).toEqual({ kind: 'invalid', message: '训练日期和有效分钟数必须同时填写。' });
  });
});
