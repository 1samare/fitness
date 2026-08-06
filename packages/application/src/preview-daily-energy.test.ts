import { describe, expect, it } from 'vitest';
import { UnknownTrainingSessionError, previewDailyEnergy } from './preview-daily-energy';

const payload = {
  ageYears: 30,
  sexCode: 0 as const,
  heightCm: 175,
  weightKg: 70,
  healthScopeConfirmed: true,
  nonTrainingActivity: 'light' as const,
  goal: 'maintain' as const,
  training: { sessionCode: '02054', durationMinutes: 60 }
};

describe('previewDailyEnergy', () => {
  it('maps a reviewed training code before calculation', () => {
    expect(previewDailyEnergy(payload)).toEqual(expect.objectContaining({
      kind: 'supported',
      trainingNetKcal: 184,
      targetEnergyKcal: 2557
    }));
  });

  it('fails closed for an unreviewed training code', () => {
    expect(() => previewDailyEnergy({
      ...payload,
      training: { sessionCode: '99999', durationMinutes: 60 }
    })).toThrow(UnknownTrainingSessionError);
  });
});
