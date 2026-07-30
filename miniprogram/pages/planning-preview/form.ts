import {
  planningApiRequestSchema,
  type PlanningApiRequest,
  type PlanningApiResponse
} from '@fitness/contracts';

const activityValues = ['light', 'moderate', 'heavy'] as const;
const goalValues = ['maintain', 'fat_loss', 'muscle_gain'] as const;

export interface PlanningFormInput {
  readonly ageYears: string;
  readonly heightCm: string;
  readonly weightKg: string;
  readonly durationMinutes: string;
  readonly sexCode: '' | '0' | '1';
  readonly activityIndex: number;
  readonly goalIndex: number;
  readonly trainingIndex: number;
  readonly healthScopeConfirmed: boolean;
}

export interface PlanningApiCaller {
  call(request: PlanningApiRequest): Promise<PlanningApiResponse>;
}

export type PlanningFormSubmission =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'response'; readonly response: PlanningApiResponse };

function buildPlanningRequest(input: PlanningFormInput): PlanningApiRequest | undefined {
  if (input.sexCode === '') return undefined;
  const activity = activityValues[input.activityIndex - 1];
  const goal = goalValues[input.goalIndex - 1];
  if (activity === undefined || goal === undefined) return undefined;

  const training = input.trainingIndex === 1
    ? undefined
    : input.trainingIndex === 2
      ? { sessionCode: '02054', durationMinutes: Number(input.durationMinutes) }
      : null;
  if (training === null) return undefined;

  const candidate = {
    action: 'previewDailyEnergy',
    payload: {
      ageYears: Number(input.ageYears),
      sexCode: input.sexCode === '0' ? 0 : 1,
      heightCm: Number(input.heightCm),
      weightKg: Number(input.weightKg),
      healthScopeConfirmed: input.healthScopeConfirmed,
      nonTrainingActivity: activity,
      goal,
      ...(training === undefined ? {} : { training })
    }
  };
  const parsed = planningApiRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export async function submitPlanningForm(
  input: PlanningFormInput,
  caller: PlanningApiCaller
): Promise<PlanningFormSubmission> {
  const request = buildPlanningRequest(input);
  if (request === undefined) {
    return {
      kind: 'invalid',
      message: '请完整填写身体数据，并明确选择公式性别变量、日常活动、健身目标和当日训练。'
    };
  }
  return { kind: 'response', response: await caller.call(request) };
}
