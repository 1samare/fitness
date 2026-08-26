import { describe, expect, test } from 'vitest';
import {
  buildPlanningSetupPayload,
  createDefaultPlanningSetupForm
} from './planning-form';

describe('local Web planning form', () => {
  test('builds a closed seven-day command without inventing training sessions', () => {
    const form = createDefaultPlanningSetupForm('2026-08-26');

    const result = buildPlanningSetupPayload(form);

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.bodyProfile.ageYears).toBe(30);
      expect(result.payload.bodyProfile.healthScopeConfirmed).toBe(true);
      expect(result.payload.bodyProfile.businessTimezone).toBe('Asia/Shanghai');
      expect(result.payload.goal.effectiveDate).toBe('2026-08-26');
      expect(result.payload.trainingPlan.weekStartDate).toBe('2026-08-26');
      expect(result.payload.trainingPlan.sessions).toEqual([]);
    }
    expect(form.trainingDays).toHaveLength(7);
  });

  test('allows an explicit unconfirmed health scope so the deterministic policy can reject it', () => {
    const form = {
      ...createDefaultPlanningSetupForm('2026-08-26'),
      healthScopeConfirmed: false
    };

    const result = buildPlanningSetupPayload(form);

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.bodyProfile.healthScopeConfirmed).toBe(false);
    }
  });

  test('rejects an enabled training day without a reviewed session and duration', () => {
    const form = createDefaultPlanningSetupForm('2026-08-26');
    const first = form.trainingDays[0];
    if (first === undefined) throw new Error('Expected first training day');

    const result = buildPlanningSetupPayload({
      ...form,
      trainingDays: [{ ...first, enabled: true }, ...form.trainingDays.slice(1)]
    });

    expect(result).toEqual({
      kind: 'invalid',
      message: '已启用的训练日必须选择审核训练类别并填写有效分钟数。'
    });
  });

  test('accepts only a reviewed session code for an enabled training day', () => {
    const form = createDefaultPlanningSetupForm('2026-08-26');
    const first = form.trainingDays[0];
    if (first === undefined) throw new Error('Expected first training day');

    const result = buildPlanningSetupPayload({
      ...form,
      trainingDays: [{
        ...first,
        enabled: true,
        sessionCode: '02050',
        durationMinutes: '60'
      }, ...form.trainingDays.slice(1)]
    });

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.trainingPlan.sessions).toEqual([{
        businessDate: '2026-08-26',
        sessionCode: '02050',
        durationMinutes: 60
      }]);
    }
  });
});
