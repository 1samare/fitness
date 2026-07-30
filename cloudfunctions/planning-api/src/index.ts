import type { PlanningApiResponse } from '@fitness/contracts';
import { handlePlanningApi } from './handler';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function main(event: unknown): Promise<PlanningApiResponse> {
  if (!isRecord(event) || !('body' in event)) return handlePlanningApi(event);
  const body = event.body;
  if (typeof body !== 'string') return handlePlanningApi(body);
  try {
    return await handlePlanningApi(JSON.parse(body) as unknown);
  } catch {
    return { success: false, error: { code: 'invalid_request', message: '请求体不是有效 JSON。' } };
  }
}
