import { planningApiRequestSchema, type PlanningApiRequest } from '@fitness/contracts';

type InventoryRequest = Extract<PlanningApiRequest, { action: 'saveInventory' }>;
type GenerationRequest = Extract<PlanningApiRequest, { action: 'generateWeeklyMealPlan' }>;

export type InventoryGenerationRecoveryStatus =
  | 'replay_required'
  | 'confirmed_infeasible'
  | 'inventory_mismatch';

const terminalRecoveryMessages = {
  confirmed_infeasible: '当前食材与营养目标没有可行餐单。服务已确认本次没有写入餐单；请调整食材后明确重新生成。',
  inventory_mismatch: '已生成餐单未关联本次保存或当前生效的库存。旧餐单会保留并标记待更新；请明确按当前库存重新生成。'
} as const;

export const inventoryGenerationWorkflowStorageKey = 'fitness.inventoryGenerationWorkflow.v1';

export interface InventoryGenerationWorkflow {
  readonly fingerprint: string;
  readonly stage: 'inventory_pending' | 'generation_pending';
  readonly inventoryRequest: InventoryRequest;
  readonly generationRequest: GenerationRequest;
  readonly inventoryVersionId: string | null;
  readonly recoveryStatus: InventoryGenerationRecoveryStatus;
  readonly recoveryMessage: string;
}

interface WorkflowRequests {
  readonly inventoryRequest: InventoryRequest;
  readonly generationRequest: GenerationRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fingerprint(requests: WorkflowRequests): string {
  return JSON.stringify({
    items: requests.inventoryRequest.payload.payload.items,
    weekStartDate: requests.generationRequest.payload.payload.weekStartDate
  });
}

function parseRequests(value: Record<string, unknown>): WorkflowRequests | undefined {
  const inventory = planningApiRequestSchema.safeParse(value.inventoryRequest);
  const generation = planningApiRequestSchema.safeParse(value.generationRequest);
  if (
    !inventory.success || inventory.data.action !== 'saveInventory'
    || !generation.success || generation.data.action !== 'generateWeeklyMealPlan'
  ) return undefined;
  return { inventoryRequest: inventory.data, generationRequest: generation.data };
}

export function createInventoryGenerationWorkflow(
  requests: WorkflowRequests
): InventoryGenerationWorkflow {
  const parsed = parseRequests(requests as unknown as Record<string, unknown>);
  if (parsed === undefined) throw new Error('库存与餐单生成请求无效');
  return {
    fingerprint: fingerprint(parsed),
    stage: 'inventory_pending',
    inventoryRequest: parsed.inventoryRequest,
    generationRequest: parsed.generationRequest,
    inventoryVersionId: null,
    recoveryStatus: 'replay_required',
    recoveryMessage: ''
  };
}

export function advanceInventoryGenerationWorkflow(
  workflow: InventoryGenerationWorkflow,
  inventoryVersionId: string
): InventoryGenerationWorkflow {
  if (workflow.stage !== 'inventory_pending' || inventoryVersionId.length === 0) {
    throw new Error('库存保存阶段无效');
  }
  return { ...workflow, stage: 'generation_pending', inventoryVersionId };
}

export function markInventoryGenerationWorkflowRecovery(
  workflow: InventoryGenerationWorkflow,
  recoveryStatus: Exclude<InventoryGenerationRecoveryStatus, 'replay_required'>
): InventoryGenerationWorkflow {
  if (workflow.stage !== 'generation_pending') {
    throw new Error('只有餐单生成阶段可以进入已确认的恢复状态');
  }
  return {
    ...workflow,
    recoveryStatus,
    recoveryMessage: terminalRecoveryMessages[recoveryStatus]
  };
}

export function inventoryGenerationWorkflowMatches(
  workflow: InventoryGenerationWorkflow,
  requests: WorkflowRequests
): boolean {
  return workflow.fingerprint === fingerprint(requests);
}

export function parseInventoryGenerationWorkflow(
  value: unknown
): InventoryGenerationWorkflow | undefined {
  const keys = isRecord(value) ? Object.keys(value) : [];
  const isLegacy = keys.length === 5;
  if (
    !isRecord(value)
    || (!isLegacy && keys.length !== 7)
    || typeof value.fingerprint !== 'string'
    || (value.stage !== 'inventory_pending' && value.stage !== 'generation_pending')
    || (value.inventoryVersionId !== null && typeof value.inventoryVersionId !== 'string')
  ) return undefined;
  const recoveryStatus = isLegacy ? 'replay_required' : value.recoveryStatus;
  const recoveryMessage = isLegacy ? '' : value.recoveryMessage;
  if (
    recoveryStatus !== 'replay_required'
    && recoveryStatus !== 'confirmed_infeasible'
    && recoveryStatus !== 'inventory_mismatch'
  ) return undefined;
  if (typeof recoveryMessage !== 'string') return undefined;
  const requests = parseRequests(value);
  if (requests === undefined || value.fingerprint !== fingerprint(requests)) return undefined;
  if (
    value.stage === 'inventory_pending'
    && (
      value.inventoryVersionId !== null
      || recoveryStatus !== 'replay_required'
      || recoveryMessage !== ''
    )
  ) return undefined;
  if (
    value.stage === 'generation_pending'
    && (typeof value.inventoryVersionId !== 'string' || value.inventoryVersionId.length === 0)
  ) return undefined;
  if (
    (recoveryStatus === 'replay_required' && recoveryMessage !== '')
    || (
      recoveryStatus !== 'replay_required'
      && recoveryMessage !== terminalRecoveryMessages[recoveryStatus]
    )
  ) return undefined;
  return {
    fingerprint: value.fingerprint,
    stage: value.stage,
    inventoryRequest: requests.inventoryRequest,
    generationRequest: requests.generationRequest,
    inventoryVersionId: value.inventoryVersionId,
    recoveryStatus,
    recoveryMessage
  };
}
