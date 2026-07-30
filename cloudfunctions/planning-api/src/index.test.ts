import { describe, expect, it } from 'vitest';
import { main } from './index';

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
});
