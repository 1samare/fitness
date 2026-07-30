import { describe, expect, it } from 'vitest';
import { roundHalfUp } from './rounding';

describe('roundHalfUp', () => {
  it('rounds non-negative display values half up at an explicit precision', () => {
    expect(roundHalfUp(2556.5, 0)).toBe(2557);
    expect(roundHalfUp(22.855, 2)).toBe(22.86);
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(10.075, 2)).toBe(10.08);
    expect(roundHalfUp(1.0049, 2)).toBe(1);
  });
});
