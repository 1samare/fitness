import { describe, expect, test } from 'vitest';
import { sha256HexUtf8 } from './sync-sha256';

describe('browser-safe synchronous SHA-256', () => {
  test.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['健身', '5d925cc69d52ad83b3bfe95ae3e2f42a059f624e2b3089d00f1c1dd1d29f2a33']
  ])('hashes UTF-8 input %# using the SHA-256 standard vector', (input, expected) => {
    expect(sha256HexUtf8(input)).toBe(expected);
  });
});
