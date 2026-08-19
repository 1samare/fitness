import {
  planningApiResponseSchema,
  type PlanningApiRequest,
  type PlanningApiResponse
} from '@fitness/contracts';

declare const __FITNESS_API_MODE__: PlanningApiMode | undefined;

export type PlanningTransport = (request: PlanningApiRequest) => Promise<unknown>;
export type CloudFunctionInvoker = (
  functionName: 'planning-api',
  data: PlanningApiRequest
) => Promise<unknown>;

export const PLANNING_API_TIMEOUT_MS = 20_000;

function withPlanningApiTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('规划服务请求超时，请稍后重试。'));
    }, PLANNING_API_TIMEOUT_MS);
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
        reject(error instanceof Error
          ? error
          : new Error('规划服务请求失败，请稍后重试。'));
      }
    );
  });
}

export function createCloudPlanningTransport(
  invoke: CloudFunctionInvoker
): PlanningTransport {
  return (request) => invoke('planning-api', request);
}

export function createPlanningApiClient(transport: PlanningTransport) {
  return {
    async call(request: PlanningApiRequest): Promise<PlanningApiResponse> {
      const parsed = planningApiResponseSchema.safeParse(
        await withPlanningApiTimeout(transport(request))
      );
      if (!parsed.success) throw new Error('规划服务返回了无法识别的数据。');
      return parsed.data;
    }
  };
}

export type PlanningApiMode = 'local' | 'cloud';

export function createPlanningApiClientForMode(
  mode: PlanningApiMode,
  transports: {
    readonly local: PlanningTransport;
    readonly cloud: PlanningTransport;
  }
) {
  return createPlanningApiClient(mode === 'cloud' ? transports.cloud : transports.local);
}

const localTransport: PlanningTransport = (request) => new Promise((resolve, reject) => {
  wx.request({
    url: 'http://127.0.0.1:3000/',
    method: 'POST',
    data: request,
    timeout: PLANNING_API_TIMEOUT_MS,
    success: (response) => { resolve(response.data); },
    fail: () => { reject(new Error('无法连接本地规划服务，请先运行 pnpm dev:api。')); }
  });
});

const cloudTransport = createCloudPlanningTransport((functionName, data) => new Promise(
  (resolve, reject) => {
    wx.cloud.callFunction({
      name: functionName,
      data,
      success: (response) => { resolve(response.result); },
      fail: () => { reject(new Error('无法连接云端规划服务，请稍后重试。')); }
    });
  }
));

const apiMode: PlanningApiMode = typeof __FITNESS_API_MODE__ === 'undefined'
  ? 'local'
  : __FITNESS_API_MODE__;

export const planningApiClient = createPlanningApiClientForMode(apiMode, {
  local: localTransport,
  cloud: cloudTransport
});
