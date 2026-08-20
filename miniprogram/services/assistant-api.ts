import {
  assistantApiRequestSchema,
  assistantApiResponseSchema,
  type AssistantApiRequest,
  type AssistantApiResponse
} from '@fitness/contracts';

declare const __FITNESS_API_MODE__: AssistantApiMode | undefined;

export type AssistantTransport = (request: AssistantApiRequest) => Promise<unknown>;
export type AssistantCloudFunctionInvoker = (
  functionName: 'assistant-api',
  data: AssistantApiRequest
) => Promise<unknown>;
export type AssistantLocalRequester = (
  url: 'http://127.0.0.1:3001/',
  data: AssistantApiRequest,
  timeout: number
) => Promise<unknown>;

export const ASSISTANT_API_TIMEOUT_MS = 120_000;

function withAssistantApiTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('助手服务请求超时，请稍后重试。'));
    }, ASSISTANT_API_TIMEOUT_MS);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('助手服务请求失败，请稍后重试。'));
      }
    );
  });
}

export function createCloudAssistantTransport(
  invoke: AssistantCloudFunctionInvoker
): AssistantTransport {
  return (request) => invoke('assistant-api', request);
}

export function createLocalAssistantTransport(
  requestLocal: AssistantLocalRequester
): AssistantTransport {
  return (request) => requestLocal(
    'http://127.0.0.1:3001/', request, ASSISTANT_API_TIMEOUT_MS
  );
}

export function createAssistantApiClient(transport: AssistantTransport) {
  return {
    async call(request: AssistantApiRequest): Promise<AssistantApiResponse> {
      const parsedRequest = assistantApiRequestSchema.safeParse(request);
      if (!parsedRequest.success) throw new Error('助手请求包含不受支持的字段。');
      const parsedResponse = assistantApiResponseSchema.safeParse(
        await withAssistantApiTimeout(transport(parsedRequest.data))
      );
      if (!parsedResponse.success) throw new Error('助手服务返回了无法识别的数据。');
      return parsedResponse.data;
    }
  };
}

export type AssistantApiMode = 'local' | 'cloud';

export function createAssistantApiClientForMode(
  mode: AssistantApiMode,
  transports: {
    readonly local: AssistantTransport;
    readonly cloud: AssistantTransport;
  }
) {
  return createAssistantApiClient(mode === 'cloud' ? transports.cloud : transports.local);
}

const localTransport = createLocalAssistantTransport((url, data, timeout) => new Promise(
  (resolve, reject) => {
    wx.request({
      url,
      method: 'POST',
      data,
      timeout,
      success: (response) => { resolve(response.data); },
      fail: () => { reject(new Error('无法连接本地助手服务，请先运行 pnpm dev:assistant。')); }
    });
  }
));

const cloudTransport = createCloudAssistantTransport((functionName, data) => new Promise(
  (resolve, reject) => {
    wx.cloud.callFunction({
      name: functionName,
      data,
      success: (response) => { resolve(response.result); },
      fail: () => { reject(new Error('无法连接云端助手服务，请稍后重试。')); }
    });
  }
));

const apiMode: AssistantApiMode = typeof __FITNESS_API_MODE__ === 'undefined'
  ? 'local'
  : __FITNESS_API_MODE__;

export const assistantApiClient = createAssistantApiClientForMode(apiMode, {
  local: localTransport,
  cloud: cloudTransport
});
