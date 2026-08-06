import type { PlanningApiRequest, PlanningApiResponse } from '@fitness/contracts';
import { describe, expect, it } from 'vitest';
import {
  submitPlanningForm,
  type PlanningApiCaller,
  type PlanningFormInput
} from './form';

const emptyForm: PlanningFormInput = {
  ageYears: '',
  heightCm: '',
  weightKg: '',
  durationMinutes: '',
  sexCode: '',
  activityIndex: 0,
  goalIndex: 0,
  trainingIndex: 0,
  healthScopeConfirmed: false
};

function recordingCaller() {
  const requests: PlanningApiRequest[] = [];
  const response: PlanningApiResponse = {
    success: false,
    error: { code: 'internal_error', message: 'test response' }
  };
  const caller: PlanningApiCaller = {
    call(request) {
      requests.push(request);
      return Promise.resolve(response);
    }
  };
  return { caller, requests };
}

describe('planning preview form submission', () => {
  it('does not call the API for the untouched initial form', async () => {
    const { caller, requests } = recordingCaller();
    const result = await submitPlanningForm(emptyForm, caller);
    expect(result.kind).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  it('does not call the API while required choices remain implicit', async () => {
    const { caller, requests } = recordingCaller();
    const result = await submitPlanningForm({
      ...emptyForm,
      ageYears: '30',
      heightCm: '175',
      weightKg: '70',
      sexCode: '0'
    }, caller);
    expect(result.kind).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  it('does not call the API for malformed numeric input', async () => {
    const { caller, requests } = recordingCaller();
    const result = await submitPlanningForm({
      ...emptyForm,
      ageYears: 'thirty',
      heightCm: '175',
      weightKg: '70',
      sexCode: '0',
      activityIndex: 1,
      goalIndex: 1,
      trainingIndex: 1
    }, caller);
    expect(result.kind).toBe('invalid');
    expect(requests).toHaveLength(0);
  });

  it('calls the API only after every required value is explicit', async () => {
    const { caller, requests } = recordingCaller();
    const result = await submitPlanningForm({
      ...emptyForm,
      ageYears: '30',
      heightCm: '175',
      weightKg: '70',
      durationMinutes: '60',
      sexCode: '0',
      activityIndex: 1,
      goalIndex: 1,
      trainingIndex: 2,
      healthScopeConfirmed: true
    }, caller);

    expect(result.kind).toBe('response');
    expect(requests).toEqual([{
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
    }]);
  });

  it('submits an explicit no-training choice without a training payload', async () => {
    const { caller, requests } = recordingCaller();
    const result = await submitPlanningForm({
      ...emptyForm,
      ageYears: '30',
      heightCm: '175',
      weightKg: '70',
      sexCode: '0',
      activityIndex: 1,
      goalIndex: 1,
      trainingIndex: 1,
      healthScopeConfirmed: true
    }, caller);

    expect(result.kind).toBe('response');
    expect(requests).toEqual([{
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'maintain'
      }
    }]);
  });
});
