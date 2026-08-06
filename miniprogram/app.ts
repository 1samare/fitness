declare const __FITNESS_API_MODE__: 'local' | 'cloud' | undefined;

if (
  typeof __FITNESS_API_MODE__ !== 'undefined'
  && __FITNESS_API_MODE__ === 'cloud'
) {
  wx.cloud.init({ traceUser: true });
}

App({});
