import { randomUUID } from 'node:crypto';
import {
  IdempotencyKeyReuseError,
  InvalidGoalError,
  InvalidTrainingPlanError,
  PastTrainingChangeError,
  PlanningPrerequisiteError,
  TrainingDateOutsideGoalPeriodError,
  UnknownTrainingSessionError,
  VersionConflictError,
  createVersionedPlanningService,
  previewDailyEnergy
} from '@fitness/application';
import {
  planningApiRequestSchema,
  planningApiResponseSchema,
  type PlanningApiResponse
} from '@fitness/contracts';
import type {
  BodyProfileVersion,
  CurrentPlanningContext,
  DailyEnergyTargetVersion,
  GoalVersion,
  TrainingPlanVersion
} from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';

const knownActions = new Set([
  'health',
  'previewDailyEnergy',
  'saveBodyProfile',
  'saveGoal',
  'saveTrainingPlan',
  'completePlanningSetup',
  'getCurrentContext'
]);

const authenticatedActions = new Set([
  'saveBodyProfile',
  'saveGoal',
  'saveTrainingPlan',
  'completePlanningSetup',
  'getCurrentContext'
]);

const repository = new InMemoryPlanningRepository();
const planningService = createVersionedPlanningService({
  repository,
  now: () => new Date().toISOString(),
  nextId: (prefix) => `${prefix}-${randomUUID()}`
});

export type VersionedPlanningService = ReturnType<typeof createVersionedPlanningService>;

export interface TrustedRequestContext {
  readonly userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicBodyProfile(version: BodyProfileVersion) {
  return {
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    payload: {
      ...version.payload,
      allergens: [...version.payload.allergens],
      avoidFoods: [...version.payload.avoidFoods],
      dietPreferences: [...version.payload.dietPreferences]
    }
  };
}

function publicGoal(version: GoalVersion) {
  return {
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    bodyProfileVersionId: version.bodyProfileVersionId,
    payload: version.payload
  };
}

function publicTrainingPlan(version: TrainingPlanVersion) {
  return {
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    bodyProfileVersionId: version.bodyProfileVersionId,
    goalVersionId: version.goalVersionId,
    payload: {
      ...version.payload,
      sessions: version.payload.sessions.map((session) => ({ ...session }))
    }
  };
}

function publicDailyEnergyTarget(version: DailyEnergyTargetVersion) {
  return {
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    businessDate: version.businessDate,
    bodyProfileVersionId: version.bodyProfileVersionId,
    goalVersionId: version.goalVersionId,
    trainingPlanVersionId: version.trainingPlanVersionId,
    energyPolicyVersion: version.energyPolicyVersion,
    nutritionPolicyVersion: version.nutritionPolicyVersion,
    energy: version.energy
  };
}

function currentContextResponse(context: CurrentPlanningContext) {
  return {
    kind: 'current_context' as const,
    bodyProfile: context.bodyProfile === null ? null : publicBodyProfile(context.bodyProfile),
    goal: context.goal === null ? null : publicGoal(context.goal),
    trainingPlan: context.trainingPlan === null ? null : publicTrainingPlan(context.trainingPlan),
    dailyEnergyTargets: context.dailyEnergyTargets.map(publicDailyEnergyTarget),
    latestVersions: context.latestVersions
  };
}

function errorResponse(
  code: Extract<PlanningApiResponse, { success: false }>['error']['code'],
  message: string
): PlanningApiResponse {
  return { success: false, error: { code, message } };
}

async function executeAuthenticatedAction(
  request: Exclude<
    ReturnType<typeof planningApiRequestSchema.parse>,
    { action: 'health' | 'previewDailyEnergy' }
  >,
  context: TrustedRequestContext,
  service: VersionedPlanningService
): Promise<PlanningApiResponse> {
  if (request.action === 'saveBodyProfile') {
    const version = await service.saveBodyProfile(context.userId, request.payload);
    return { success: true, data: { kind: 'body_profile_saved', version: publicBodyProfile(version) } };
  }
  if (request.action === 'saveGoal') {
    const version = await service.saveGoal(context.userId, request.payload);
    return { success: true, data: { kind: 'goal_saved', version: publicGoal(version) } };
  }
  if (request.action === 'saveTrainingPlan') {
    const result = await service.saveTrainingPlan(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'training_plan_saved',
        trainingPlan: publicTrainingPlan(result.trainingPlan),
        dailyEnergyTargets: result.dailyEnergyTargets.map(publicDailyEnergyTarget)
      }
    };
  }
  if (request.action === 'completePlanningSetup') {
    const result = await service.completePlanningSetup(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'planning_setup_completed',
        bodyProfile: publicBodyProfile(result.bodyProfile),
        goal: publicGoal(result.goal),
        trainingPlan: publicTrainingPlan(result.trainingPlan),
        dailyEnergyTargets: result.dailyEnergyTargets.map(publicDailyEnergyTarget),
        affectedDates: [...result.affectedDates]
      }
    };
  }
  const current = await service.getCurrentContext(context.userId);
  return { success: true, data: currentContextResponse(current) };
}

async function handlePlanningApiResult(
  input: unknown,
  context: TrustedRequestContext | undefined,
  service: VersionedPlanningService
): Promise<PlanningApiResponse> {
  if (isRecord(input) && typeof input.action === 'string' && !knownActions.has(input.action)) {
    return errorResponse('unknown_action', '不支持的操作。');
  }

  const parsed = planningApiRequestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message
    }));
    const firstIssue = issues[0];
    return {
      success: false,
      error: {
        code: 'invalid_request',
        message: firstIssue === undefined
          ? '请求参数不合法。'
          : `请求参数不合法。诊断：${firstIssue.path || '根对象'}：${firstIssue.message}`,
        issues
      }
    };
  }

  if (parsed.data.action === 'health') {
    return {
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    };
  }

  if (parsed.data.action === 'previewDailyEnergy') {
    try {
      return { success: true, data: previewDailyEnergy(parsed.data.payload) };
    } catch (error: unknown) {
      if (error instanceof UnknownTrainingSessionError) {
        return errorResponse(error.code, '训练会话缺少已审核的 MET 映射。');
      }
      return errorResponse('internal_error', '规划服务暂时不可用。');
    }
  }

  if (authenticatedActions.has(parsed.data.action) && context === undefined) {
    return errorResponse('unauthenticated', '需要可信的微信用户身份。');
  }

  try {
    if (context === undefined) return errorResponse('unauthenticated', '需要可信的微信用户身份。');
    return await executeAuthenticatedAction(parsed.data, context, service);
  } catch (error: unknown) {
    if (error instanceof VersionConflictError) {
      return errorResponse(error.code, '数据已被更新，请刷新后重试。');
    }
    if (error instanceof IdempotencyKeyReuseError) {
      return errorResponse(error.code, '幂等键已用于其他写操作。');
    }
    if (error instanceof PlanningPrerequisiteError) {
      return errorResponse(error.code, '请先完成身体档案和健身目标。');
    }
    if (error instanceof InvalidGoalError) {
      return errorResponse(error.code, '减脂目标不能使 BMI 低于 18.5。');
    }
    if (error instanceof InvalidTrainingPlanError) {
      return errorResponse(error.code, '训练日期必须唯一且位于当前规划周。');
    }
    if (error instanceof PastTrainingChangeError) {
      return errorResponse(error.code, '过去日期的训练记录不可修改。');
    }
    if (error instanceof TrainingDateOutsideGoalPeriodError) {
      return errorResponse(error.code, '训练日期必须位于当前目标周期内。');
    }
    if (error instanceof UnknownTrainingSessionError) {
      return errorResponse(error.code, '训练会话缺少已审核的 MET 映射。');
    }
    return errorResponse('internal_error', '规划服务暂时不可用。');
  }
}

export function createPlanningApiHandler(service: VersionedPlanningService) {
  return async (
    input: unknown,
    context?: TrustedRequestContext
  ): Promise<PlanningApiResponse> => planningApiResponseSchema.parse(
    await handlePlanningApiResult(input, context, service)
  );
}

export const handlePlanningApi = createPlanningApiHandler(planningService);
