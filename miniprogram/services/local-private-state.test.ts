import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAllLocalPrivateState } from './local-private-state';

afterEach(() => { vi.unstubAllGlobals(); });

describe('local private state clearing', () => {
  it('uses the platform-wide storage clear so current and future private recovery keys are removed', () => {
    const clearStorageSync = vi.fn();
    vi.stubGlobal('wx', { clearStorageSync });

    clearAllLocalPrivateState();

    expect(clearStorageSync).toHaveBeenCalledOnce();
  });
});
