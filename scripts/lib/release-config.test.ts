import { describe, expect, test } from 'vitest';
import {
  parseConfiguredServerNames,
  validateControlledBetaMetadata
} from './release-config.mjs';

describe('release configuration validators', () => {
  test('accepts controlled-beta public values and configured-name sets', () => {
    expect(validateControlledBetaMetadata({
      FITNESS_PUBLIC_OPERATOR_NAME: '受控测试运营主体',
      FITNESS_PUBLIC_PRIVACY_CONTACT: 'privacy@example.test',
      FITNESS_PRIVACY_NOTICE_VERSION: 'beta-2026-08-20'
    })).toEqual({
      operatorName: '受控测试运营主体',
      privacyContact: 'privacy@example.test',
      privacyNoticeVersion: 'beta-2026-08-20'
    });
    expect([...parseConfiguredServerNames('B,A,A')]).toEqual(['A', 'B']);
  });

  test.each([
    ['FITNESS_PUBLIC_OPERATOR_NAME', '仅限本地开发，不得发布'],
    ['FITNESS_PUBLIC_PRIVACY_CONTACT', 'local-only@invalid.example'],
    ['FITNESS_PRIVACY_NOTICE_VERSION', 'local-dev'],
    ['FITNESS_PUBLIC_PRIVACY_CONTACT', 'not-a-contact']
  ] as const)('rejects non-release %s metadata', (name, value) => {
    expect(() => validateControlledBetaMetadata({
      FITNESS_PUBLIC_OPERATOR_NAME: '受控测试运营主体',
      FITNESS_PUBLIC_PRIVACY_CONTACT: 'privacy@example.test',
      FITNESS_PRIVACY_NOTICE_VERSION: 'beta-2026-08-20',
      [name]: value
    })).toThrow();
  });

  test('rejects empty or invalid configured server names', () => {
    expect(() => parseConfiguredServerNames('')).toThrow();
    expect(() => parseConfiguredServerNames('VALID_NAME,invalid-name')).toThrow();
  });
});
