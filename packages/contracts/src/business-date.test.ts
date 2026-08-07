import { describe, expect, test } from 'vitest';
import { addBusinessDays, isBusinessDate } from './business-date';

describe('business dates', () => {
  test.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '26-08-07'])(
    'rejects invalid calendar date %s',
    (value) => { expect(isBusinessDate(value)).toBe(false); }
  );

  test.each(['2024-02-29', '2026-08-07', '2000-01-01'])(
    'accepts real calendar date %s',
    (value) => { expect(isBusinessDate(value)).toBe(true); }
  );

  test('adds days without local-time rollover', () => {
    expect(addBusinessDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addBusinessDays('2024-02-28', 2)).toBe('2024-03-01');
  });
});
