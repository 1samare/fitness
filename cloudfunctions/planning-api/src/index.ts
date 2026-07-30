import type { PlanningApiResponse } from '@fitness/contracts';
import {
  handlePlanningApi,
  type TrustedRequestContext
} from './handler';
import { resolveDefaultRuntimeIdentity } from './runtime-identity';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvent(event: unknown): unknown {
  if (!isRecord(event) || !('body' in event)) return event;
  const body = event.body;
  if (typeof body !== 'string') return body;
  return JSON.parse(body) as unknown;
}

export interface MainDependencies {
  readonly resolveIdentity: (runtimeContext: unknown) => TrustedRequestContext | undefined;
  readonly handle: (
    input: unknown,
    context?: TrustedRequestContext
  ) => Promise<PlanningApiResponse>;
}

export function createMain(dependencies: MainDependencies) {
  return async (event: unknown, runtimeContext?: unknown): Promise<PlanningApiResponse> => {
    let input: unknown;
    try {
      input = normalizeEvent(event);
    } catch {
      return {
        success: false,
        error: { code: 'invalid_request', message: '请求体不是有效 JSON。' }
      };
    }
    const trustedContext = dependencies.resolveIdentity(runtimeContext);
    return dependencies.handle(input, trustedContext);
  };
}

export const main = createMain({
  resolveIdentity: () => resolveDefaultRuntimeIdentity(),
  handle: handlePlanningApi
});
