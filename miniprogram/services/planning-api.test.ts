import { describe, expect, it } from 'vitest';
import { createPlanningApiClient } from './planning-api';

describe('mini program planning API client', () => {
  it('validates the response before returning it', async () => {
    const client = createPlanningApiClient(() => Promise.resolve({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    }));
    const response = await client.call({ action: 'health' });
    expect(response.success).toBe(true);
  });

  it('rejects an unvalidated server payload', async () => {
    const client = createPlanningApiClient(() => Promise.resolve({ success: true, calories: 9999 }));
    await expect(client.call({ action: 'health' })).rejects.toThrow('规划服务返回了无法识别的数据');
  });
});
