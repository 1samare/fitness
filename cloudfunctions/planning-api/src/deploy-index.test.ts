import { afterEach, describe, expect, test, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  getWxContext: vi.fn<() => { readonly OPENID?: string }>(
    () => ({ OPENID: '  wx-deploy-user  ' })
  ),
  handle: vi.fn((_input: unknown, context: unknown) => Promise.resolve({
    success: false as const,
    error: {
      code: 'internal_error' as const,
      message: context === undefined ? 'unauthenticated' : JSON.stringify(context)
    }
  }))
}));

vi.mock('wx-server-sdk', () => ({
  getWXContext: runtime.getWxContext,
  init: vi.fn()
}));

vi.mock('./cloud-runtime-handler', () => ({
  createDefaultCloudRuntimePlanningHandler: () => runtime.handle
}));

import { main } from './deploy-index';

describe('production planning entry identity', () => {
  const originalRuntimeMode = process.env.FITNESS_RUNTIME_MODE;
  const originalLocalUserId = process.env.FITNESS_LOCAL_USER_ID;

  afterEach(() => {
    if (originalRuntimeMode === undefined) delete process.env.FITNESS_RUNTIME_MODE;
    else process.env.FITNESS_RUNTIME_MODE = originalRuntimeMode;
    if (originalLocalUserId === undefined) delete process.env.FITNESS_LOCAL_USER_ID;
    else process.env.FITNESS_LOCAL_USER_ID = originalLocalUserId;
    vi.clearAllMocks();
  });

  test('ignores local-mode environment identity and trusts only trimmed WXContext OPENID', async () => {
    process.env.FITNESS_RUNTIME_MODE = 'local';
    process.env.FITNESS_LOCAL_USER_ID = 'environment-selected-user';

    await expect(main({ action: 'health' })).resolves.toMatchObject({
      error: { message: JSON.stringify({ userId: 'wx-deploy-user' }) }
    });
  });

  test('fails closed when WXContext OPENID is missing even if local identity is configured', async () => {
    process.env.FITNESS_RUNTIME_MODE = 'local';
    process.env.FITNESS_LOCAL_USER_ID = 'environment-selected-user';
    runtime.getWxContext.mockReturnValueOnce({});

    await expect(main({ action: 'health' })).resolves.toMatchObject({
      error: { message: 'unauthenticated' }
    });
  });
});
