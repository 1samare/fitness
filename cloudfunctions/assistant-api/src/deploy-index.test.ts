import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  getWxContext: vi.fn<() => { readonly OPENID?: string }>(
    () => ({ OPENID: '  wx-deploy-user  ' })
  ),
  handle: vi.fn((_input: unknown, context: unknown) => Promise.resolve({
    success: false as const,
    error: {
      code: 'internal_error' as const,
      message: context === undefined ? 'unauthenticated' : JSON.stringify(context),
      recoveryAction: 'retry' as const
    }
  }))
}));

vi.mock('wx-server-sdk', () => ({
  getWXContext: runtime.getWxContext
}));

vi.mock('./cloud-runtime-handler', () => ({
  createDefaultCloudRuntimeAssistantHandler: () => runtime.handle
}));

import { main } from './deploy-index';

describe('production assistant entry identity', () => {
  const originalRuntimeMode = process.env.FITNESS_RUNTIME_MODE;
  const originalLocalUserId = process.env.FITNESS_LOCAL_USER_ID;

  afterEach(() => {
    if (originalRuntimeMode === undefined) delete process.env.FITNESS_RUNTIME_MODE;
    else process.env.FITNESS_RUNTIME_MODE = originalRuntimeMode;
    if (originalLocalUserId === undefined) delete process.env.FITNESS_LOCAL_USER_ID;
    else process.env.FITNESS_LOCAL_USER_ID = originalLocalUserId;
    vi.clearAllMocks();
  });

  it('ignores local identity configuration and trusts only WXContext OPENID', async () => {
    process.env.FITNESS_RUNTIME_MODE = 'local';
    process.env.FITNESS_LOCAL_USER_ID = 'environment-selected-user';
    await expect(main({ action: 'getAssistantConversation' })).resolves.toMatchObject({
      error: { message: JSON.stringify({ userId: 'wx-deploy-user' }) }
    });
  });

  it('fails closed when WXContext OPENID is absent', async () => {
    process.env.FITNESS_LOCAL_USER_ID = 'environment-selected-user';
    runtime.getWxContext.mockReturnValueOnce({});
    await expect(main({ action: 'getAssistantConversation' })).resolves.toMatchObject({
      error: { message: 'unauthenticated' }
    });
  });
});
