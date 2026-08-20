import { describe, expect, it } from 'vitest';
import { releaseMetadata } from './release-metadata';

describe('mini program release metadata', () => {
  it('uses unmistakable non-release values for a development build', () => {
    expect(releaseMetadata).toEqual({
      channel: 'development',
      operatorName: '仅限本地开发，不得发布',
      privacyContact: 'local-only@invalid.example',
      privacyNoticeVersion: 'local-dev'
    });
    expect(Object.isFrozen(releaseMetadata)).toBe(true);
  });
});
