import * as cloud from 'wx-server-sdk';
import type { TrustedRequestContext } from './handler';

export function resolveCloudRuntimeIdentity(): TrustedRequestContext | undefined {
  const openId = cloud.getWXContext().OPENID?.trim();
  return openId === undefined || openId.length === 0
    ? undefined
    : { userId: openId };
}
