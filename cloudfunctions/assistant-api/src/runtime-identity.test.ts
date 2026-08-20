import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentity } from './runtime-identity';

describe('assistant runtime identity', () => {
  it('uses only a trimmed WXContext OPENID in cloud mode', () => {
    expect(resolveRuntimeIdentity({
      runtimeMode: 'cloud',
      getWxContext: () => ({ OPENID: '  wx-user  ' }),
      localUserId: 'ignored-local-user'
    })).toEqual({ userId: 'wx-user' });
    expect(resolveRuntimeIdentity({
      runtimeMode: 'cloud',
      getWxContext: () => ({}),
      localUserId: 'ignored-local-user'
    })).toBeUndefined();
  });

  it('allows an explicit local-only identity without reading event fields', () => {
    expect(resolveRuntimeIdentity({
      runtimeMode: 'local',
      getWxContext: () => ({ OPENID: 'ignored-cloud-user' }),
      localUserId: ' local-development-user '
    })).toEqual({ userId: 'local-development-user' });
  });
});
