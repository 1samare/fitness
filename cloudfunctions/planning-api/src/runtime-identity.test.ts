import { describe, expect, test } from 'vitest';
import { resolveRuntimeIdentity } from './runtime-identity';

describe('resolveRuntimeIdentity', () => {
  test('uses the OpenID supplied by the mini-program cloud runtime', () => {
    expect(resolveRuntimeIdentity({
      getWxContext: () => ({ OPENID: 'wx-openid-a', SOURCE: 'wx-client' }),
      runtimeMode: 'cloud'
    })).toEqual({ userId: 'wx-openid-a' });
  });

  test('fails closed when the cloud runtime has no OpenID', () => {
    expect(resolveRuntimeIdentity({
      getWxContext: () => ({ SOURCE: 'http' }),
      runtimeMode: 'cloud'
    })).toBeUndefined();
  });

  test('only permits a fixed local identity in explicit local mode', () => {
    expect(resolveRuntimeIdentity({
      getWxContext: () => ({}),
      runtimeMode: 'local',
      localUserId: 'local-development-user'
    })).toEqual({ userId: 'local-development-user' });
    expect(resolveRuntimeIdentity({
      getWxContext: () => ({}),
      runtimeMode: 'cloud',
      localUserId: 'local-development-user'
    })).toBeUndefined();
  });
});
