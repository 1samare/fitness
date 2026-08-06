import {
  planningApiResponseSchema,
  type PlanningApiRequest,
  type PlanningApiResponse
} from '@fitness/contracts';

export type PlanningTransport = (request: PlanningApiRequest) => Promise<unknown>;

export function createPlanningApiClient(transport: PlanningTransport) {
  return {
    async call(request: PlanningApiRequest): Promise<PlanningApiResponse> {
      const parsed = planningApiResponseSchema.safeParse(await transport(request));
      if (!parsed.success) throw new Error('规划服务返回了无法识别的数据。');
      return parsed.data;
    }
  };
}

const localTransport: PlanningTransport = (request) => new Promise((resolve, reject) => {
  wx.request({
    url: 'http://127.0.0.1:3000/',
    method: 'POST',
    data: request,
    timeout: 10_000,
    success: (response) => { resolve(response.data); },
    fail: () => { reject(new Error('无法连接本地规划服务，请先运行 pnpm dev:api。')); }
  });
});

export const planningApiClient = createPlanningApiClient(localTransport);
