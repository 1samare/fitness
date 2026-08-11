import { planningApiRequestSchema, type PlanningApiRequest } from '@fitness/contracts';

type InventoryRequest = Extract<PlanningApiRequest, { action: 'saveInventory' }>;
type GenerationRequest = Extract<PlanningApiRequest, { action: 'generateWeeklyMealPlan' }>;

export const inventoryGenerationWorkflowStorageKey = 'fitness.inventoryGenerationWorkflow.v1';

export interface InventoryGenerationWorkflow {
  readonly fingerprint: string;
  readonly stage: 'inventory_pending' | 'generation_pending';
  readonly inventoryRequest: InventoryRequest;
  readonly generationRequest: GenerationRequest;
  readonly inventoryVersionId: string | null;
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
    inventoryVersionId: null
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

export function inventoryGenerationWorkflowMatches(
  workflow: InventoryGenerationWorkflow,
  requests: WorkflowRequests
): boolean {
  return workflow.fingerprint === fingerprint(requests);
}

export function parseInventoryGenerationWorkflow(
  value: unknown
): InventoryGenerationWorkflow | undefined {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 5
    || typeof value.fingerprint !== 'string'
    || (value.stage !== 'inventory_pending' && value.stage !== 'generation_pending')
    || (value.inventoryVersionId !== null && typeof value.inventoryVersionId !== 'string')
  ) return undefined;
  const requests = parseRequests(value);
  if (requests === undefined || value.fingerprint !== fingerprint(requests)) return undefined;
  if (value.stage === 'inventory_pending' && value.inventoryVersionId !== null) return undefined;
  if (
    value.stage === 'generation_pending'
    && (typeof value.inventoryVersionId !== 'string' || value.inventoryVersionId.length === 0)
  ) return undefined;
  return {
    fingerprint: value.fingerprint,
    stage: value.stage,
    inventoryRequest: requests.inventoryRequest,
    generationRequest: requests.generationRequest,
    inventoryVersionId: value.inventoryVersionId
  };
}
