import { describe, expect, test } from 'vitest';
import {
  buildPlanningSetupPayload,
  buildTrainingDayRows,
  type PlanningSetupFormInput,
  type TrainingDayFormInput
} from './form';

const baseForm = {
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
  weekStartDate: '2026-08-03'
} as const;

function formWith(trainingDays: readonly TrainingDayFormInput[]): PlanningSetupFormInput {
  return { ...baseForm, trainingDays };
}

function enabledRow(row: TrainingDayFormInput, durationMinutes = '60') {
  return {
    ...row,
    enabled: true,
    sessionCode: '02054',
    durationMinutes
  };
}

describe('weekly planning setup form', () => {
  test('builds seven exact consecutive rows across a month boundary', () => {
    expect(buildTrainingDayRows(
      '2026-08-28',
      '2026-08-01',
      '2026-08-01',
      '2026-09-30'
    ).map((row) => row.businessDate)).toEqual([
      '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31',
      '2026-09-01', '2026-09-02', '2026-09-03'
    ]);
  });

  test('omits a fully disabled week and normalizes comma-separated preferences', () => {
    const rows = buildTrainingDayRows(
      '2026-08-03',
      '2026-08-10',
      '2026-08-03',
      '2026-10-26'
    );
    const result = buildPlanningSetupPayload(formWith(rows));

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.trainingPlan.sessions).toEqual([]);
      expect(result.payload.bodyProfile.allergens).toEqual(['花生', '虾']);
    }
  });

  test('maps seven enabled rows to seven date-ordered reviewed sessions', () => {
    const rows = buildTrainingDayRows(
      '2026-08-03',
      '2026-08-03',
      '2026-08-03',
      '2026-10-26'
    ).map((row, index) => enabledRow(row, String(30 + index)));
    const result = buildPlanningSetupPayload(formWith(rows));

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.trainingPlan.sessions).toHaveLength(7);
      expect(result.payload.trainingPlan.sessions.map((session) => session.businessDate))
        .toEqual(rows.map((row) => row.businessDate));
    }
  });

  test('preserves two selected reviewed sessions and numeric durations', () => {
    const rows = buildTrainingDayRows(
      '2026-08-03',
      '2026-08-03',
      '2026-08-03',
      '2026-10-26'
    ).map((row, index) => (
      index === 1 || index === 4 ? enabledRow(row, index === 1 ? '45' : '75') : row
    ));
    const result = buildPlanningSetupPayload(formWith(rows));

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.trainingPlan.sessions).toEqual([
        { businessDate: '2026-08-04', sessionCode: '02054', durationMinutes: 45 },
        { businessDate: '2026-08-07', sessionCode: '02054', durationMinutes: 75 }
      ]);
    }
  });

  test.each([
    { sessionCode: '', durationMinutes: '60' },
    { sessionCode: '02054', durationMinutes: '' }
  ])('rejects an enabled row with incomplete reviewed-session input', (incomplete) => {
    const rows = buildTrainingDayRows(
      '2026-08-03',
      '2026-08-03',
      '2026-08-03',
      '2026-10-26'
    );
    const first = rows[0];
    if (first === undefined) throw new Error('Expected the first training day');
    const result = buildPlanningSetupPayload(formWith([
      { ...first, enabled: true, ...incomplete },
      ...rows.slice(1)
    ]));

    expect(result).toEqual({
      kind: 'invalid',
      message: '已启用的训练日必须选择审核动作并填写有效分钟数。'
    });
  });

  test('omits disabled past rows even if stale controls still contain values', () => {
    const rows = buildTrainingDayRows(
      '2026-08-03',
      '2026-08-05',
      '2026-08-03',
      '2026-10-26'
    ).map((row) => enabledRow(row));
    const result = buildPlanningSetupPayload(formWith(rows));

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.payload.trainingPlan.sessions.map((session) => session.businessDate))
        .toEqual(['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']);
    }
  });

  test('returns only the normalized payload without identity, MET, IDs, or command metadata', () => {
    const rows = buildTrainingDayRows(
      '2026-08-03',
      '2026-08-03',
      '2026-08-03',
      '2026-10-26'
    );
    const result = buildPlanningSetupPayload(formWith(rows));

    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      const serialized = JSON.stringify(result.payload);
      expect(serialized).not.toMatch(/userId|openid|\bmet\b|createdAt|VersionId|policyVersion|idempotencyKey|expectedVersions/i);
      expect(Object.keys(result.payload).sort()).toEqual([
        'bodyProfile', 'goal', 'trainingPlan'
      ]);
    }
  });
});
