import { describe, expect, it } from 'vitest';
import { calculateDailyEnergy } from './calculate-daily-energy';
import { findReviewedTrainingSession } from './reviewed-training-session';

const base = {
  ageYears: 30,
  sexCode: 0 as const,
  heightCm: 175,
  weightKg: 70,
  healthScopeConfirmed: true,
  nonTrainingActivity: 'light' as const,
  goal: 'maintain' as const
};

describe('calculateDailyEnergy', () => {
  it('separates PAL from reviewed training energy and preserves traceability', () => {
    const session = findReviewedTrainingSession('02054');
    expect(session).toBeDefined();
    if (session === undefined) return;

    const result = calculateDailyEnergy({
      ...base,
      training: { session, durationMinutes: 60 }
    });

    expect(result).toMatchObject({
      kind: 'supported',
      bmi: 22.86,
      estimatedBmrKcal: 1582,
      nonTrainingBaselineKcal: 2373,
      trainingNetKcal: 184,
      estimatedMaintenanceKcal: 2557,
      targetEnergyKcal: 2557
    });
    if (result.kind === 'supported') {
      expect(result.policy.sourceIds).toContain('MET-COMPENDIUM-2024');
    }
  });

  it.each([
    ['maintain', 2373],
    ['fat_loss', 2136],
    ['muscle_gain', 2492]
  ] as const)('applies the fixed %s adjustment without widening', (goal, expected) => {
    const result = calculateDailyEnergy({ ...base, goal });
    expect(result.kind).toBe('supported');
    if (result.kind === 'supported') expect(result.targetEnergyKcal).toBe(expected);
  });

  it('uses the user-provided sex code and all non-training PAL branches', () => {
    const female = calculateDailyEnergy({ ...base, sexCode: 1 });
    expect(female.kind).toBe('supported');
    if (female.kind === 'supported') expect(female.estimatedBmrKcal).toBe(1426);

    const moderate = calculateDailyEnergy({ ...base, nonTrainingActivity: 'moderate' });
    const heavy = calculateDailyEnergy({ ...base, nonTrainingActivity: 'heavy' });
    if (moderate.kind === 'supported') expect(moderate.nonTrainingBaselineKcal).toBe(2769);
    if (heavy.kind === 'supported') expect(heavy.nonTrainingBaselineKcal).toBe(3164);
  });

  it('adds reviewed training exactly once on top of the non-training baseline', () => {
    const session = findReviewedTrainingSession('02054');
    if (session === undefined) throw new Error('reviewed fixture 02054 is missing');
    const withoutTraining = calculateDailyEnergy(base);
    const withTraining = calculateDailyEnergy({
      ...base,
      training: { session, durationMinutes: 60 }
    });
    if (withoutTraining.kind === 'supported' && withTraining.kind === 'supported') {
      expect(withTraining.estimatedMaintenanceKcal - withoutTraining.estimatedMaintenanceKcal).toBe(184);
    }
  });

  it.each([
    ['02050', 368],
    ['02052', 294],
    ['02054', 184]
  ] as const)('uses the reviewed session-level MET for %s', (sessionCode, expectedNetKcal) => {
    const session = findReviewedTrainingSession(sessionCode);
    if (session === undefined) throw new Error(`reviewed fixture ${sessionCode} is missing`);
    const result = calculateDailyEnergy({
      ...base,
      training: { session, durationMinutes: 60 }
    });
    expect(result).toMatchObject({ kind: 'supported', trainingNetKcal: expectedNetKcal });
    expect(session.trainingKind).toBe('regular_resistance');
  });

  it('returns no target energy when BMI is 24.0', () => {
    const result = calculateDailyEnergy({ ...base, heightCm: 200, weightKg: 96 });
    expect(result).toEqual(expect.objectContaining({
      kind: 'unsupported',
      code: 'unsupported_for_personalized_energy',
      reasons: ['bmi_out_of_range']
    }));
    expect(result).not.toHaveProperty('targetEnergyKcal');
  });

  it('uses raw BMI for eligibility even when display BMI rounds to 24.00', () => {
    const result = calculateDailyEnergy({ ...base, heightCm: 200, weightKg: 95.9996 });
    expect(result.kind).toBe('supported');
    if (result.kind === 'supported') expect(result.bmi).toBe(24);
  });
});
