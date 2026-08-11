import {
  planningApiRequestSchema,
  type PlanningApiRequest,
  type PlanningApiResponse
} from '@fitness/contracts';

export type MealWriteAction =
  | 'saveInventory'
  | 'generateWeeklyMealPlan'
  | 'setMealPlanDayLock'
  | 'updateMealPlanDay'
  | 'decideMealPlanCandidate'
  | 'recordTrainingCompletion'
  | 'retryPendingRecalculation';

export type MealWriteRequest = Extract<PlanningApiRequest, { readonly action: MealWriteAction }>;

export interface PendingMealCommand {
  readonly payloadFingerprint: string;
  readonly request: MealWriteRequest;
}

const mealWriteActions = new Set<PlanningApiRequest['action']>([
  'saveInventory',
  'generateWeeklyMealPlan',
  'setMealPlanDayLock',
  'updateMealPlanDay',
  'decideMealPlanCandidate',
  'recordTrainingCompletion',
  'retryPendingRecalculation'
]);

const deterministicFailureCodes = new Set([
  'invalid_request',
  'unknown_action',
  'unknown_training_session',
  'unauthenticated',
  'version_conflict',
  'idempotency_key_reused',
  'planning_prerequisite_missing',
  'invalid_goal',
  'invalid_training_plan',
  'invalid_calendar_date',
  'past_training_change_forbidden',
  'past_fact_immutable',
  'training_date_outside_goal_period',
  'recipe_not_selectable',
  'candidate_not_pending',
  'candidate_diff_unavailable'
]);

export type PendingCommandDisposition = 'confirmed' | 'discard' | 'retain';

export function pendingCommandDisposition(
  response: PlanningApiResponse,
  confirmedKind: Extract<PlanningApiResponse, { success: true }>['data']['kind']
): PendingCommandDisposition {
  if (response.success) return response.data.kind === confirmedKind ? 'confirmed' : 'retain';
  return deterministicFailureCodes.has(response.error.code) ? 'discard' : 'retain';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMealWriteRequest(request: PlanningApiRequest): request is MealWriteRequest {
  return mealWriteActions.has(request.action);
}

function normalizedRequest(request: unknown): MealWriteRequest {
  const parsed = planningApiRequestSchema.parse(request);
  if (!isMealWriteRequest(parsed)) throw new Error('Unsupported pending meal command');
  return parsed;
}

function payloadFingerprint(request: MealWriteRequest): string {
  return JSON.stringify({ action: request.action, payload: request.payload.payload });
}

export function pendingMealCommandStorageKey(action: MealWriteAction): string {
  return `fitness.pendingMealCommand.v1.${action}`;
}

export function parsePendingMealCommand(value: unknown): PendingMealCommand | undefined {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.payloadFingerprint !== 'string'
  ) {
    return undefined;
  }
  const parsed = planningApiRequestSchema.safeParse(value.request);
  if (!parsed.success || !isMealWriteRequest(parsed.data)) return undefined;
  const expectedFingerprint = payloadFingerprint(parsed.data);
  if (value.payloadFingerprint !== expectedFingerprint) return undefined;
  return { payloadFingerprint: value.payloadFingerprint, request: parsed.data };
}

export function selectPendingMealCommand(input: {
  readonly request: MealWriteRequest;
  readonly pending: PendingMealCommand | undefined;
  readonly nextKey: () => string;
}): { readonly pending: PendingMealCommand; readonly reused: boolean } {
  const request = normalizedRequest(input.request);
  const fingerprint = payloadFingerprint(request);
  if (
    input.pending?.request.action === request.action
    && input.pending.payloadFingerprint === fingerprint
  ) {
    return { pending: input.pending, reused: true };
  }
  const created = normalizedRequest({
    ...request,
    payload: { ...request.payload, idempotencyKey: input.nextKey() }
  });
  return {
    pending: { payloadFingerprint: fingerprint, request: created },
    reused: false
  };
}
