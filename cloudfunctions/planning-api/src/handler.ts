import { randomUUID } from 'node:crypto';
import {
  IdempotencyKeyReuseError,
  InvalidGoalError,
  InvalidTrainingPlanError,
  PastFactImmutableError,
  PastTrainingChangeError,
  PlanningPrerequisiteError,
  ProviderUnavailableError,
  NutritionConstraintsInfeasibleError,
  RecipeNotSelectableError,
  TrainingDateOutsideGoalPeriodError,
  UnknownTrainingSessionError,
  VersionConflictError,
  type createMealPlanGenerationService,
  type createMealPlanEditingService,
  createVersionedPlanningService,
  previewDailyEnergy
} from '@fitness/application';
import {
  dailyNutritionTargetVersionSchema,
  planningApiRequestSchema,
  planningApiResponseSchema,
  type PlanningApiResponse
} from '@fitness/contracts';
import type {
  BodyProfileVersion,
  CurrentPlanningContext,
  DailyEnergyTargetVersion,
  DailyNutritionTargetVersion,
  GoalVersion,
  InventoryVersion,
  MealPlanTargetDiff,
  MealPlanVersion,
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
  'resolveFoodName',
  'saveInventory',
  'generateWeeklyMealPlan',
  'setMealPlanDayLock',
  'updateMealPlanDay',
  'getCurrentContext'
]);

const authenticatedActions = new Set([
  'saveBodyProfile',
  'saveGoal',
  'saveTrainingPlan',
  'completePlanningSetup',
  'resolveFoodName',
  'saveInventory',
  'generateWeeklyMealPlan',
  'setMealPlanDayLock',
  'updateMealPlanDay',
  'getCurrentContext'
]);

const repository = new InMemoryPlanningRepository();
const planningService = createVersionedPlanningService({
  repository,
  now: () => new Date().toISOString(),
  nextId: (prefix) => `${prefix}-${randomUUID()}`
});

export type VersionedPlanningService =
  | ReturnType<typeof createVersionedPlanningService>
  | ReturnType<typeof createMealPlanGenerationService>
  | ReturnType<typeof createMealPlanEditingService>;

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

function publicDailyNutritionTarget(version: DailyNutritionTargetVersion) {
  return dailyNutritionTargetVersionSchema.parse({
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    businessDate: version.businessDate,
    bodyProfileVersionId: version.bodyProfileVersionId,
    goalVersionId: version.goalVersionId,
    trainingPlanVersionId: version.trainingPlanVersionId,
    dailyEnergyTargetVersionId: version.dailyEnergyTargetVersionId,
    energyPolicyVersion: version.energyPolicyVersion,
    nutritionPolicyVersion: version.nutritionPolicyVersion,
    energy: version.energy,
    nutrition: version.nutrition
  });
}

function publicInventory(version: InventoryVersion) {
  return {
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    items: version.items.map((item) => ({ ...item }))
  };
}

function publicMealPlan(version: MealPlanVersion) {
  return {
    kind: version.kind,
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    weekStartDate: version.weekStartDate,
    bodyProfileVersionId: version.bodyProfileVersionId,
    goalVersionId: version.goalVersionId,
    trainingPlanVersionId: version.trainingPlanVersionId,
    inventoryVersionId: version.inventoryVersionId,
    catalogVersionId: version.catalogVersionId,
    generationPolicyVersion: version.generationPolicyVersion,
    supersedesVersionId: version.supersedesVersionId,
    readiness: version.readiness,
    days: version.days.map((day) => ({
      ...day,
      meals: day.meals.map((meal) => ({ ...meal })),
      ingredientAmounts: day.ingredientAmounts.map((item) => ({ ...item })),
      nutritionTotals: { ...day.nutritionTotals },
      nutritionSourceSnapshotIds: [...day.nutritionSourceSnapshotIds]
    }))
  };
}

function publicMealPlanTargetDiff(diff: MealPlanTargetDiff) {
  return {
    id: diff.id,
    candidateMealPlanVersionId: diff.candidateMealPlanVersionId,
    businessDate: diff.businessDate,
    previousNutritionTargetVersionId: diff.previousNutritionTargetVersionId,
    proposedNutritionTargetVersionId: diff.proposedNutritionTargetVersionId,
    reason: diff.reason
  };
}

function currentContextResponse(context: CurrentPlanningContext) {
  return {
    kind: 'current_context' as const,
    bodyProfile: context.bodyProfile === null ? null : publicBodyProfile(context.bodyProfile),
    goal: context.goal === null ? null : publicGoal(context.goal),
    trainingPlan: context.trainingPlan === null ? null : publicTrainingPlan(context.trainingPlan),
    dailyEnergyTargets: context.dailyEnergyTargets.map(publicDailyEnergyTarget),
    dailyNutritionTargets: context.dailyNutritionTargets.map(publicDailyNutritionTarget),
    inventory: context.inventory === null ? null : publicInventory(context.inventory),
    mealPlan: context.mealPlan === null ? null : publicMealPlan(context.mealPlan),
    mealPlanStale: context.mealPlanStale,
    pendingMealPlanCandidate: context.pendingMealPlanCandidate === null
      ? null
      : publicMealPlan(context.pendingMealPlanCandidate),
    pendingMealPlanTargetDiffs: context.pendingMealPlanTargetDiffs.map(publicMealPlanTargetDiff),
    selectableRecipes: context.selectableRecipes.map((recipe) => ({ ...recipe })),
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
        dailyEnergyTargets: result.dailyEnergyTargets.map(publicDailyEnergyTarget),
        dailyNutritionTargets: result.dailyNutritionTargets.map(publicDailyNutritionTarget)
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
        dailyNutritionTargets: result.dailyNutritionTargets.map(publicDailyNutritionTarget),
        affectedDates: [...result.affectedDates]
      }
    };
  }
  if (request.action === 'resolveFoodName') {
    if (!('resolveFoodName' in service)) throw new ProviderUnavailableError('nutrition_source_unavailable');
    const resolution = await service.resolveFoodName(request.payload.name);
    return {
      success: true,
      data: { kind: 'food_name_resolved', resolution }
    };
  }
  if (request.action === 'saveInventory') {
    if (!('saveInventory' in service)) throw new ProviderUnavailableError('nutrition_source_unavailable');
    const version = await service.saveInventory(context.userId, request.payload);
    return {
      success: true,
      data: { kind: 'inventory_saved', version: publicInventory(version) }
    };
  }
  if (request.action === 'generateWeeklyMealPlan') {
    if (!('generateWeeklyMealPlan' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const version = await service.generateWeeklyMealPlan(context.userId, request.payload);
    return {
      success: true,
      data: { kind: 'weekly_meal_plan_generated', version: publicMealPlan(version) }
    };
  }
  if (request.action === 'setMealPlanDayLock') {
    if (!('setMealPlanDayLock' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const version = await service.setMealPlanDayLock(context.userId, request.payload);
    return {
      success: true,
      data: { kind: 'meal_plan_updated', version: publicMealPlan(version) }
    };
  }
  if (request.action === 'updateMealPlanDay') {
    if (!('updateMealPlanDay' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const version = await service.updateMealPlanDay(context.userId, request.payload);
    return {
      success: true,
      data: { kind: 'meal_plan_updated', version: publicMealPlan(version) }
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
    if (error instanceof PastFactImmutableError) {
      return errorResponse(error.code, '今天及过去日期的餐单事实不可修改。');
    }
    if (error instanceof TrainingDateOutsideGoalPeriodError) {
      return errorResponse(error.code, '训练日期必须位于当前目标周期内。');
    }
    if (error instanceof UnknownTrainingSessionError) {
      return errorResponse(error.code, '训练会话缺少已审核的 MET 映射。');
    }
    if (error instanceof ProviderUnavailableError) {
      return errorResponse(error.code, '营养数据暂时不可用。');
    }
    if (error instanceof RecipeNotSelectableError) {
      return errorResponse(error.code, '请选择当前上下文提供的备选菜品。');
    }
    if (error instanceof NutritionConstraintsInfeasibleError) {
      return errorResponse(error.code, '当前食材与营养目标无法生成可行的一周餐单。');
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
