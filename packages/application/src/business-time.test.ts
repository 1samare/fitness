import { describe, expect, test } from 'vitest';
import { businessDateAt } from './business-time';

describe('businessDateAt', () => {
  test('uses the requested business timezone across a UTC date boundary', () => {
    expect(businessDateAt('2026-08-06T16:30:00.000Z', 'Asia/Shanghai'))
      .toBe('2026-08-07');
    expect(businessDateAt('2026-08-06T16:30:00.000Z', 'America/Los_Angeles'))
      .toBe('2026-08-06');
  });

  test('rejects an invalid instant or timezone', () => {
    expect(() => businessDateAt('not-an-instant', 'Asia/Shanghai')).toThrow();
    expect(() => businessDateAt('2026-08-06T16:30:00.000Z', 'Asia/Not_A_Zone')).toThrow();
  });
});
