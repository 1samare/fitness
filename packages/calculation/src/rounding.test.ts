import { describe, expect, it } from 'vitest';
import { roundHalfUp } from './rounding';

describe('roundHalfUp', () => {
  it('rounds non-negative display values half up at an explicit precision', () => {
    expect(roundHalfUp(2556.5, 0)).toBe(2557);
    expect(roundHalfUp(22.855, 2)).toBe(22.86);
  });
});
