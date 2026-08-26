import { expect, it, describe } from 'vitest';
import { stableSha256Input, sha256Hex } from './sha256';

describe('web sha256 utility', () => {
  it('normalizes object order before hashing', async () => {
    const first = stableSha256Input({ b: 2, a: 1 });
    const second = stableSha256Input({ a: 1, b: 2 });
    expect(first).toBe(second);
    expect(await sha256Hex(first)).toBe(await sha256Hex(second));
  });

  it('is deterministic for arrays', async () => {
    const first = stableSha256Input({ values: [1, { b: 2, a: 1 }] });
    const second = stableSha256Input({ values: [1, { a: 1, b: 2 }] });
    expect(await sha256Hex(first)).toBe(await sha256Hex(second));
  });
});
