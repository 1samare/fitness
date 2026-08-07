import { afterEach, expect, test, vi } from 'vitest';

interface ZodConfiguredGlobal {
  __zod_globalConfig?: { jitless?: boolean };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as ZodConfiguredGlobal).__zod_globalConfig;
  vi.resetModules();
});

test('keeps contract validation callable when runtime code generation is restricted', async () => {
  vi.resetModules();
  delete (globalThis as ZodConfiguredGlobal).__zod_globalConfig;

  vi.stubGlobal('Function', function RestrictedFunction() {
    return Object.freeze({ kind: 'restricted-function-result' });
  });
  vi.stubGlobal('App', () => undefined);

  await import('./app');
  const { planningApiRequestSchema } = await import('@fitness/contracts');

  expect(planningApiRequestSchema.parse({ action: 'health' })).toEqual({
    action: 'health'
  });
});
