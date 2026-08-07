import {
  planningApiRequestSchema,
  planningSetupPayloadSchema,
  type PlanningApiRequest,
  type PlanningSetupPayload
} from '@fitness/contracts';
import type { PlanningVersions } from './form';

type CompleteSetupRequest = Extract<
  PlanningApiRequest,
  { action: 'completePlanningSetup' }
>;

export interface PendingPlanningSetup {
  readonly payloadFingerprint: string;
  readonly request: CompleteSetupRequest;
}

function normalizedPayload(payload: PlanningSetupPayload): PlanningSetupPayload {
  return planningSetupPayloadSchema.parse(payload);
}

function payloadFingerprint(payload: PlanningSetupPayload): string {
  return JSON.stringify(normalizedPayload(payload));
}

function requestPayload(request: CompleteSetupRequest): PlanningSetupPayload {
  return {
    bodyProfile: request.payload.bodyProfile,
    goal: request.payload.goal,
    trainingPlan: request.payload.trainingPlan
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePendingPlanningSetup(value: unknown): PendingPlanningSetup | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value;
  if (
    Object.keys(candidate).length !== 2
    || typeof candidate.payloadFingerprint !== 'string'
  ) {
    return undefined;
  }
  const parsed = planningApiRequestSchema.safeParse(candidate.request);
  if (!parsed.success || parsed.data.action !== 'completePlanningSetup') return undefined;
  const expectedFingerprint = payloadFingerprint(requestPayload(parsed.data));
  if (candidate.payloadFingerprint !== expectedFingerprint) return undefined;
  return {
    payloadFingerprint: candidate.payloadFingerprint,
    request: parsed.data
  };
}

export function pendingPlanningSetupMatches(
  pending: PendingPlanningSetup,
  payload: PlanningSetupPayload
): boolean {
  return pending.payloadFingerprint === payloadFingerprint(payload);
}

export function selectPlanningSetupCommand(input: {
  readonly payload: PlanningSetupPayload;
  readonly latestVersions: PlanningVersions;
  readonly pending: PendingPlanningSetup | undefined;
  readonly nextKey: () => string;
}): { readonly pending: PendingPlanningSetup; readonly reused: boolean } {
  const payload = normalizedPayload(input.payload);
  const fingerprint = payloadFingerprint(payload);
  if (input.pending?.payloadFingerprint === fingerprint) {
    return { pending: input.pending, reused: true };
  }
  const pending: PendingPlanningSetup = {
    payloadFingerprint: fingerprint,
    request: {
      action: 'completePlanningSetup',
      payload: {
        expectedVersions: input.latestVersions,
        idempotencyKey: input.nextKey(),
        ...payload
      }
    }
  };
  return { pending, reused: false };
}
