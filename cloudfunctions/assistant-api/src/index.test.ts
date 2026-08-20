import { describe, expect, it, vi } from 'vitest';
import { createMain } from './index';

describe('assistant CloudBase main adapter', () => {
  it('parses framework bodies and strips untrusted platform metadata', async () => {
    const handle = vi.fn(() => Promise.resolve({
      success: false as const,
      error: {
        code: 'internal_error' as const,
        message: 'fixture response',
        recoveryAction: 'retry' as const
      }
    }));
    const main = createMain({
      resolveIdentity: () => ({ userId: 'trusted-user' }),
      handle
    });
    await main({
      body: JSON.stringify({
        action: 'getAssistantConversation',
        userInfo: { openId: 'untrusted-event-user' },
        tcbContext: { userId: 'untrusted-event-user' }
      })
    });
    expect(handle).toHaveBeenCalledWith(
      { action: 'getAssistantConversation' },
      { userId: 'trusted-user' }
    );
  });

  it('maps malformed JSON and composition failures to fixed public errors', async () => {
    const malformed = createMain({
      resolveIdentity: () => undefined,
      handle: vi.fn()
    });
    await expect(malformed({ body: '{bad' })).resolves.toMatchObject({
      success: false,
      error: { code: 'invalid_request' }
    });

    const failed = createMain({
      resolveIdentity: () => ({ userId: 'trusted-user' }),
      handle: () => Promise.reject(new Error('secret configuration'))
    });
    const response = await failed({ action: 'getAssistantConversation' });
    expect(response).toEqual({
      success: false,
      error: {
        code: 'internal_error',
        message: '助手服务暂时不可用，请稍后重试。',
        recoveryAction: 'retry'
      }
    });
    expect(JSON.stringify(response)).not.toContain('secret configuration');
  });
});
