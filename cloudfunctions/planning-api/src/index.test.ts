import { describe, expect, it } from 'vitest';
import { createMain, main } from './index';
import { createRuntimePlanningHandler } from './runtime-handler';

describe('CloudBase main event adapter', () => {
  it('parses the functions-framework HTTP body', async () => {
    await expect(main({ body: JSON.stringify({ action: 'health' }) })).resolves.toEqual({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    });
  });

  it('maps malformed JSON to invalid_request without a stack', async () => {
    const result = await main({ body: '{not-json' });
    expect(result).toEqual({
      success: false,
      error: { code: 'invalid_request', message: '请求体不是有效 JSON。' }
    });
    expect(JSON.stringify(result)).not.toContain('stack');
  });

  it('passes only the runtime-resolved identity to the controller', async () => {
    const calls: unknown[] = [];
    const injectedMain = createMain({
      resolveIdentity: () => ({ userId: 'trusted-runtime-user' }),
      handle: (input, context) => {
        calls.push({ input, context });
        return Promise.resolve({
          success: false,
          error: { code: 'internal_error', message: 'test response' }
        });
      }
    });

    await injectedMain({ action: 'getCurrentContext', userId: 'client-selected-user' }, {});
    expect(calls).toEqual([{
      input: { action: 'getCurrentContext', userId: 'client-selected-user' },
      context: { userId: 'trusted-runtime-user' }
    }]);
  });

  it('does not use an identity embedded in an authenticated event', async () => {
    const injectedMain = createMain({
      resolveIdentity: () => undefined,
      handle: createRuntimePlanningHandler({ runtimeMode: 'local' })
    });
    const result = await injectedMain({
      action: 'getCurrentContext',
      userId: 'client-selected-user'
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('invalid_request');
  });
});
