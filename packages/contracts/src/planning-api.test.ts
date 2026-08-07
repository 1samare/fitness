import { describe, expect, it } from 'vitest';
import { planningApiRequestSchema, planningApiResponseSchema } from './planning-api';

const supportedRequest = {
  action: 'previewDailyEnergy',
  payload: {
    ageYears: 30,
    sexCode: 0,
    heightCm: 175,
    weightKg: 70,
    healthScopeConfirmed: true,
    nonTrainingActivity: 'light',
    goal: 'maintain',
    training: { sessionCode: '02054', durationMinutes: 60 }
  }
} as const;

const supportedResponse = {
  success: true,
  data: {
    kind: 'supported',
    bmi: 22.86,
    estimatedBmrKcal: 1582,
    nonTrainingBaselineKcal: 2373,
    trainingNetKcal: 184,
    estimatedMaintenanceKcal: 2557,
    targetEnergyKcal: 2557,
    policy: {
      policyVersion: 'calculation-policy-v2',
      sourceIds: ['CN-BMR-2023', 'CN-DRI-MACRO-2017', 'MET-COMPENDIUM-2024'],
      applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
      applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
      rounding: { kcal: 'nearest_whole_half_up', bmi: 'nearest_hundredth_half_up' }
    },
    disclaimer: '初始估算，仅供一般健身与膳食规划参考，不构成医疗建议。'
  }
} as const;

describe('planning API contracts', () => {
  it('accepts the two whitelisted actions', () => {
    expect(planningApiRequestSchema.parse({ action: 'health' })).toEqual({ action: 'health' });
    expect(planningApiRequestSchema.parse(supportedRequest)).toEqual(supportedRequest);
  });

  it('rejects malformed numbers', () => {
    expect(() => planningApiRequestSchema.parse({
      ...supportedRequest,
      payload: {
        ...supportedRequest.payload,
        weightKg: Number.NaN
      }
    })).toThrow();
  });

  it('rejects client supplied MET', () => {
    expect(() => planningApiRequestSchema.parse({
      ...supportedRequest,
      payload: {
        ...supportedRequest.payload,
        training: { sessionCode: '02054', durationMinutes: 60, met: 3.5 }
      }
    })).toThrow();
  });

  it('parses a supported response envelope', () => {
    expect(planningApiResponseSchema.parse(supportedResponse)).toEqual(supportedResponse);
  });

  it('rejects negative or fractional display energy values', () => {
    expect(() => planningApiResponseSchema.parse({
      ...supportedResponse,
      data: { ...supportedResponse.data, trainingNetKcal: -1 }
    })).toThrow();
    expect(() => planningApiResponseSchema.parse({
      ...supportedResponse,
      data: { ...supportedResponse.data, targetEnergyKcal: 2557.5 }
    })).toThrow();
  });

  it('accepts versioned writes without accepting a client userId', () => {
    const request = {
      action: 'saveBodyProfile',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'profile-create-001',
        payload: {
          ageYears: 30,
          sexCode: 0,
          heightCm: 175,
          weightKg: 70,
          healthScopeConfirmed: true,
          nonTrainingActivity: 'light',
          allergens: ['peanut'],
          avoidFoods: [],
          dietPreferences: ['home_cooking'],
          businessTimezone: 'Asia/Shanghai'
        }
      }
    } as const;

    expect(planningApiRequestSchema.parse(request)).toEqual(request);
    expect(() => planningApiRequestSchema.parse({
      ...request,
      payload: { ...request.payload, userId: 'attacker-selected-user' }
    })).toThrow();
  });

  it('requires version and idempotency controls on every write', () => {
    expect(() => planningApiRequestSchema.parse({
      action: 'saveGoal',
      payload: {
        payload: {
          goal: 'maintain',
          effectiveDate: '2026-08-03',
          targetDate: '2026-10-26'
        }
      }
    })).toThrow();
  });

  it('rejects impossible goal and training calendar dates', () => {
    expect(() => planningApiRequestSchema.parse({
      action: 'saveGoal',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'goal-invalid-date-001',
        payload: {
          goal: 'maintain',
          effectiveDate: '2026-02-30',
          targetDate: '2026-03-30'
        }
      }
    })).toThrow();

    expect(() => planningApiRequestSchema.parse({
      action: 'saveTrainingPlan',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'training-invalid-date-001',
        payload: {
          weekStartDate: '2025-02-29',
          businessTimezone: 'Asia/Shanghai',
          sessions: []
        }
      }
    })).toThrow();
  });

  it('accepts atomic setup without accepting a client userId', () => {
    const request = {
      action: 'completePlanningSetup',
      payload: {
        expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
        idempotencyKey: 'setup-create-001',
        bodyProfile: {
          ageYears: 30,
          sexCode: 0,
          heightCm: 175,
          weightKg: 70,
          healthScopeConfirmed: true,
          nonTrainingActivity: 'light',
          allergens: [],
          avoidFoods: [],
          dietPreferences: [],
          businessTimezone: 'Asia/Shanghai'
        },
        goal: {
          goal: 'maintain',
          effectiveDate: '2026-08-07',
          targetDate: '2026-10-30'
        },
        trainingPlan: {
          weekStartDate: '2026-08-10',
          businessTimezone: 'Asia/Shanghai',
          sessions: []
        }
      }
    } as const;

    expect(planningApiRequestSchema.parse(request)).toEqual(request);
    expect(() => planningApiRequestSchema.parse({
      ...request,
      payload: { ...request.payload, userId: 'attacker-selected-user' }
    })).toThrow();
    expect(() => planningApiRequestSchema.parse({
      ...request,
      userId: 'attacker-selected-user'
    })).toThrow();
  });
});
