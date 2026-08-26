import { describe, expect, it } from 'vitest';
import { detectBrowserCapabilities } from './capability-check';

describe('browser capability check', () => {
  it('passes when all required features are present', () => {
    const mockEnv = {
      indexedDB: { open: () => ({}) },
      crypto: { subtle: {} },
      BroadcastChannel: () => ({}),
      structuredClone: () => ({}),
      URL: { createObjectURL: () => '' }
    };

    const report = detectBrowserCapabilities(mockEnv);
    expect(report.supported).toBe(true);
    expect(report.unsupported).toHaveLength(0);
  });

  it('returns browser_capability_unsupported details', () => {
    const mockEnv = {
      indexedDB: { open: () => ({}) }
    };
    const report = detectBrowserCapabilities(mockEnv);
    expect(report.supported).toBe(false);
    expect(report.unsupported).toContain('web_crypto_subtle');
    expect(report.unsupported).toContain('broadcast_channel');
    expect(report.unsupported).toContain('structured_clone');
    expect(report.unsupported).toContain('object_url');
  });
});
