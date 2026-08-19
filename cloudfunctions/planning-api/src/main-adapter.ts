import type { PlanningApiResponse } from '@fitness/contracts';
import type { TrustedRequestContext } from './handler';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function removePlatformEventMetadata(input: unknown): unknown {
  if (!isRecord(input) || (!('userInfo' in input) && !('tcbContext' in input))) return input;
  const normalizedInput = { ...input };
  delete normalizedInput.userInfo;
  delete normalizedInput.tcbContext;
  return normalizedInput;
}

function normalizeEvent(event: unknown): unknown {
  if (!isRecord(event) || !('body' in event)) return removePlatformEventMetadata(event);
  const body = typeof event.body === 'string'
    ? JSON.parse(event.body) as unknown
    : event.body;
  return removePlatformEventMetadata(body);
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
