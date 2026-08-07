declare const __FITNESS_API_MODE__: 'local' | 'cloud' | undefined;

interface ZodConfiguredGlobal {
  __zod_globalConfig?: { jitless?: boolean };
}

const validationRuntimeGlobal = globalThis as ZodConfiguredGlobal;
validationRuntimeGlobal.__zod_globalConfig ??= {};
validationRuntimeGlobal.__zod_globalConfig.jitless = true;

if (
  typeof __FITNESS_API_MODE__ !== 'undefined'
  && __FITNESS_API_MODE__ === 'cloud'
) {
  wx.cloud.init({ traceUser: true });
}

App({});

export {};
