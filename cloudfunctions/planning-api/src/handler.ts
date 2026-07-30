import { UnknownTrainingSessionError, previewDailyEnergy } from '@fitness/application';
import {
  planningApiRequestSchema,
  type PlanningApiResponse
} from '@fitness/contracts';

const knownActions = new Set(['health', 'previewDailyEnergy']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handlePlanningApiResult(input: unknown): PlanningApiResponse {
  if (isRecord(input) && typeof input.action === 'string' && !knownActions.has(input.action)) {
    return { success: false, error: { code: 'unknown_action', message: '不支持的操作。' } };
  }

  const parsed = planningApiRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'invalid_request',
        message: '请求参数不合法。',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    };
  }

  if (parsed.data.action === 'health') {
    return {
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    };
  }

  try {
    return { success: true, data: previewDailyEnergy(parsed.data.payload) };
  } catch (error: unknown) {
    if (error instanceof UnknownTrainingSessionError) {
      return {
        success: false,
        error: { code: error.code, message: '训练会话缺少已审核的 MET 映射。' }
      };
    }
    return { success: false, error: { code: 'internal_error', message: '规划服务暂时不可用。' } };
  }
}

export function handlePlanningApi(input: unknown): Promise<PlanningApiResponse> {
  return Promise.resolve(handlePlanningApiResult(input));
}
