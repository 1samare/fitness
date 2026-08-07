import { describe, expect, test, vi } from 'vitest';
import type { PlanningSetupPayload } from '@fitness/contracts';
import {
  selectPlanningSetupCommand,
  type PendingPlanningSetup
} from './pending-command';

function setupPayload(weightKg = 70): PlanningSetupPayload {
  return {
    bodyProfile: {
      ageYears: 30,
      sexCode: 0,
      heightCm: 175,
      weightKg,
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
      sessions: [
        { businessDate: '2026-08-11', sessionCode: '02054', durationMinutes: 60 }
      ]
    }
  };
}

const literalPending: PendingPlanningSetup = {
  payloadFingerprint: JSON.stringify(setupPayload()),
  request: {
    action: 'completePlanningSetup',
    payload: {
      expectedVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      idempotencyKey: 'planning-setup-key-001',
      ...setupPayload()
    }
  }
};

describe('selectPlanningSetupCommand', () => {
  test('creates one complete command and calls nextKey exactly once', () => {
    const nextKey = vi.fn(() => 'planning-setup-key-001');

    const selected = selectPlanningSetupCommand({
      payload: setupPayload(),
      latestVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      pending: undefined,
      nextKey
    });

    expect(selected).toEqual({ pending: literalPending, reused: false });
    expect(nextKey).toHaveBeenCalledTimes(1);
  });

  test('reuses the stored full request even when newly supplied versions differ', () => {
    const nextKey = vi.fn(() => 'must-not-be-used');

    const selected = selectPlanningSetupCommand({
      payload: setupPayload(),
      latestVersions: { bodyProfile: 9, goal: 8, trainingPlan: 7 },
      pending: literalPending,
      nextKey
    });

    expect(selected).toEqual({ pending: literalPending, reused: true });
    expect(nextKey).not.toHaveBeenCalled();
  });

  test('creates a new key and command when normalized payload changes', () => {
    const nextKey = vi.fn(() => 'planning-setup-key-002');

    const selected = selectPlanningSetupCommand({
      payload: setupPayload(69.5),
      latestVersions: { bodyProfile: 1, goal: 1, trainingPlan: 1 },
      pending: literalPending,
      nextKey
    });

    expect(selected.reused).toBe(false);
    expect(selected.pending.request.payload.idempotencyKey).toBe('planning-setup-key-002');
    expect(selected.pending.request.payload.expectedVersions).toEqual({
      bodyProfile: 1,
      goal: 1,
      trainingPlan: 1
    });
    expect(selected.pending.request.payload.bodyProfile.weightKg).toBe(69.5);
    expect(nextKey).toHaveBeenCalledTimes(1);
  });

  test('stores only the validated complete request and its private payload fingerprint', () => {
    const selected = selectPlanningSetupCommand({
      payload: setupPayload(),
      latestVersions: { bodyProfile: 0, goal: 0, trainingPlan: 0 },
      pending: undefined,
      nextKey: () => 'planning-setup-key-001'
    });
    const serialized = JSON.stringify(selected.pending);

    expect(selected.pending.request).toEqual(literalPending.request);
    expect(Object.keys(selected.pending).sort()).toEqual(['payloadFingerprint', 'request']);
    expect(serialized).not.toMatch(/userId|openid|response|result/i);
  });
});
