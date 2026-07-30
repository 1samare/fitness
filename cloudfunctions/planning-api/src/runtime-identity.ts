import * as cloud from 'wx-server-sdk';
import type { TrustedRequestContext } from './handler';

interface WxContext {
  readonly OPENID?: string | undefined;
  readonly SOURCE?: string | undefined;
}

export interface RuntimeIdentityOptions {
  readonly getWxContext: () => WxContext;
  readonly runtimeMode: 'cloud' | 'local';
  readonly localUserId?: string | undefined;
}

export function resolveRuntimeIdentity(
  options: RuntimeIdentityOptions
): TrustedRequestContext | undefined {
  if (options.runtimeMode === 'local') {
    const localUserId = options.localUserId?.trim();
    return localUserId === undefined || localUserId.length === 0
      ? undefined
      : { userId: localUserId };
  }

  const openId = options.getWxContext().OPENID?.trim();
  return openId === undefined || openId.length === 0
    ? undefined
    : { userId: openId };
}

export function resolveDefaultRuntimeIdentity(): TrustedRequestContext | undefined {
  const runtimeMode = process.env.FITNESS_RUNTIME_MODE === 'local' ? 'local' : 'cloud';
  if (runtimeMode === 'cloud') {
    cloud.init();
  }
  return resolveRuntimeIdentity({
    runtimeMode,
    getWxContext: () => cloud.getWXContext(),
    localUserId: process.env.FITNESS_LOCAL_USER_ID
  });
}
