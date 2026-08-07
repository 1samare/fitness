import { describe, expect, test } from 'vitest';
import { requestFingerprint } from './idempotency-fingerprint';

describe('requestFingerprint', () => {
  test('ignores object insertion order at every depth', () => {
    const left = {
      expectedVersion: 0,
      payload: {
        goal: 'maintain',
        dates: { from: '2026-08-07', to: '2026-08-14' }
      }
    };
    const right = {
      payload: {
        dates: { to: '2026-08-14', from: '2026-08-07' },
        goal: 'maintain'
      },
      expectedVersion: 0
    };

    expect(requestFingerprint(left)).toBe(requestFingerprint(right));
  });

  test('preserves array order', () => {
    expect(requestFingerprint({ sessions: ['02054', 'rest'] }))
      .not.toBe(requestFingerprint({ sessions: ['rest', '02054'] }));
  });

  test('uses a deterministic total order for distinct Unicode keys', () => {
    expect(requestFingerprint({ '\u00e9': 1, 'e\u0301': 2 }))
      .toBe(requestFingerprint({ 'e\u0301': 2, '\u00e9': 1 }));
  });

  test('stores only a versioned digest', () => {
    expect(requestFingerprint({ healthScopeConfirmed: true }))
      .toMatch(/^v2:sha256:[0-9a-f]{64}$/);
  });

  test('rejects non-finite numbers instead of colliding with JSON null', () => {
    expect(() => requestFingerprint({ weightKg: Number.NaN })).toThrow(TypeError);
    expect(() => requestFingerprint({ weightKg: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});
