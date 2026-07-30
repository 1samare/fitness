import { describe, expect, it } from 'vitest';
import { evaluateEligibility } from './eligibility';

const base = { heightCm: 200, weightKg: 80, healthScopeConfirmed: true };

describe('calculation-policy-v2 eligibility', () => {
  it.each([18, 45])('accepts age boundary %s', (ageYears) => {
    expect(evaluateEligibility({ ...base, ageYears, weightKg: 80 }).reasons).not.toContain('age_out_of_range');
  });

  it.each([17, 46])('rejects age %s', (ageYears) => {
    expect(evaluateEligibility({ ...base, ageYears, weightKg: 80 }).reasons).toContain('age_out_of_range');
  });

  it('accepts BMI 18.5 and rejects raw BMI 24.0', () => {
    expect(evaluateEligibility({ ...base, ageYears: 30, weightKg: 74 }).reasons).not.toContain('bmi_out_of_range');
    expect(evaluateEligibility({ ...base, ageYears: 30, weightKg: 96 }).reasons).toContain('bmi_out_of_range');
  });

  it('requires the health scope confirmation', () => {
    expect(evaluateEligibility({ ...base, ageYears: 30, healthScopeConfirmed: false }).reasons)
      .toContain('health_scope_not_confirmed');
  });
});
