import type { TrustedAssistantRequestContext } from './handler';

interface WxContext {
  readonly OPENID?: string | undefined;
}

export interface RuntimeIdentityOptions {
  readonly runtimeMode: 'cloud' | 'local';
  readonly getWxContext: () => WxContext;
  readonly localUserId?: string | undefined;
}

export function resolveRuntimeIdentity(
  options: RuntimeIdentityOptions
): TrustedAssistantRequestContext | undefined {
  const candidate = options.runtimeMode === 'local'
    ? options.localUserId
    : options.getWxContext().OPENID;
  const userId = candidate?.trim();
  return userId === undefined || userId.length === 0
    ? undefined
    : { userId };
}
