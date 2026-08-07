import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const parsed: unknown = JSON.parse(
  readFileSync(
    new URL('../../../cloudbase/function.rules.json', import.meta.url),
    'utf8'
  )
);

if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  throw new Error('CloudBase function rules must be an object.');
}

const rules = parsed as Record<string, unknown>;

function invokeRuleFor(functionName: string): unknown {
  const candidate = rules[functionName] ?? rules['*'];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  return (candidate as Record<string, unknown>).invoke;
}

describe('CloudBase function rules', () => {
  test('denies unlisted functions and requires authentication for planning-api', () => {
    expect(invokeRuleFor('unlisted-function')).toBe(false);
    expect(invokeRuleFor('planning-api')).toBe('auth != null');
  });
});
