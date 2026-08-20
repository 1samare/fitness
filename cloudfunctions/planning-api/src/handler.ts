import { randomUUID } from 'node:crypto';
import {
  AccountCapacityExceededError,
  AccountDeletionPendingError,
  CandidateDiffUnavailableError,
  CandidateConfirmationRequiredError,
  CandidateNotPendingError,
  IngredientPhotoNotFoundError,
  IdempotencyKeyReuseError,
  InvalidGoalError,
  InvalidTrainingPlanError,
  FutureCompletionForbiddenError,
  PastFactImmutableError,
  PastTrainingChangeError,
  PlanningPrerequisiteError,
  PrivatePhotoOwnershipError,
  ProviderUnavailableError,
  NutritionConstraintsInfeasibleError,
  PersonalDataSnapshotConflictError,
  RecipeNotSelectableError,
  StorageUnavailableError,
  TrainingDateOutsideGoalPeriodError,
  UnknownTrainingSessionError,
  VersionConflictError,
  createAccountDeletionGuardedRepository,
  createPersonalDataService,
  type createMealPlanGenerationService,
  type createMealPlanEditingService,
  type createMealPlanRecalculationService,
  type createIngredientPhotoPlanningService,
  type PersonalDataService,
  createVersionedPlanningService,
  previewDailyEnergy
} from '@fitness/application';
import {
  dailyNutritionTargetVersionSchema,
  planningApiRequestSchema,
  planningApiResponseSchema,
  type PlanningApiResponse,
  type PublicWeeklyMealConflict
} from '@fitness/contracts';
import type {
  BodyProfileVersion,
  CurrentPlanningContext,
  DailyEnergyTargetVersion,
  DailyNutritionTargetVersion,
  GoalVersion,
  InventoryVersion,
  IngredientPhotoVersion,
  MealPlanTargetDiff,
  MealPlanVersion,
  MealPlanDecision,
  PrivatePhotoStorage,
  RecalculationJob,
  TrainingCompletionEvent,
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
  'resizeMealPlanPortion',
  'recordTrainingCompletion',
  'decideMealPlanCandidate',
  'retryPendingRecalculation',
  'createIngredientPhotoUpload',
  'registerIngredientPhotoUpload',
  'recognizeIngredientPhoto',
  'confirmIngredientCandidate',
  'getPersonalDataSummary',
  'exportPersonalData',
  'deleteAccount',
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
  'resizeMealPlanPortion',
  'recordTrainingCompletion',
  'decideMealPlanCandidate',
  'retryPendingRecalculation',
  'createIngredientPhotoUpload',
  'registerIngredientPhotoUpload',
  'recognizeIngredientPhoto',
  'confirmIngredientCandidate',
  'getPersonalDataSummary',
  'exportPersonalData',
  'deleteAccount',
  'getCurrentContext'
]);

const rawRepository = new InMemoryPlanningRepository();
const guardedRepository = createAccountDeletionGuardedRepository(rawRepository);
const defaultNow = () => new Date().toISOString();
const defaultPrivatePhotoStorage: PrivatePhotoStorage = {
  inspectPrivateFile: () => Promise.reject(new Error('Private photo storage is unavailable')),
  deletePrivateFile: () => Promise.resolve('not_found')
};
const defaultPlanningService = createVersionedPlanningService({
  repository: guardedRepository,
  now: defaultNow,
  nextId: (prefix) => `${prefix}-${randomUUID()}`
});
const planningService = Object.assign(defaultPlanningService, createPersonalDataService({
  repository: rawRepository,
  storage: defaultPrivatePhotoStorage,
  now: defaultNow
}));

export type VersionedPlanningService =
  | ReturnType<typeof createVersionedPlanningService>
  | ReturnType<typeof createMealPlanGenerationService>
  | ReturnType<typeof createMealPlanEditingService>
  | ReturnType<typeof createMealPlanRecalculationService>
  | ReturnType<typeof createIngredientPhotoPlanningService>;

export type PlanningApiService = VersionedPlanningService & Pick<
  PersonalDataService,
  'getPersonalDataSummary' | 'exportPersonalData' | 'deleteAccount'
>;

type HandlerPlanningService = VersionedPlanningService | PlanningApiService;

export interface TrustedRequestContext {
  readonly userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStableErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function isRecalculationJob(value: unknown): value is RecalculationJob {
  return isRecord(value) && value.kind === 'recalculation_job';
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
    ...(version.trainingCompletionEventId === undefined
      ? {}
      : { trainingCompletionEventId: version.trainingCompletionEventId }),
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
    ...(version.trainingCompletionEventId === undefined
      ? {}
      : { trainingCompletionEventId: version.trainingCompletionEventId }),
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
      meals: day.meals.map((meal) => (
        meal.dishNameZh !== undefined
        && meal.ingredients !== undefined
        && meal.ingredients.length > 0
          ? {
              slot: meal.slot,
              recipeTemplateVersionId: meal.recipeTemplateVersionId,
              servingMultiplier: meal.servingMultiplier,
              displayStatus: 'complete' as const,
              dishNameZh: meal.dishNameZh,
              ingredients: meal.ingredients.map((ingredient) => ({ ...ingredient }))
            }
          : {
              slot: meal.slot,
              recipeTemplateVersionId: meal.recipeTemplateVersionId,
              servingMultiplier: meal.servingMultiplier,
              displayStatus: 'legacy_unavailable' as const,
              dishNameZh: '历史餐单菜名暂不可用' as const,
              ingredients: [],
              displayMessage: '历史餐单缺少展示快照，数值记录仍保留，可重新生成补齐。' as const
            }
      )),
      ingredientAmounts: day.ingredientAmounts.map((item) => ({ ...item })),
      nutritionTotals: { ...day.nutritionTotals },
      nutritionSourceSnapshotIds: [...day.nutritionSourceSnapshotIds]
    }))
  };
}

function publicMealPlanTargetDiff(diff: MealPlanTargetDiff) {
  const common = {
    id: diff.id,
    candidateMealPlanVersionId: diff.candidateMealPlanVersionId,
    businessDate: diff.businessDate,
    reason: diff.reason
  };
  if (
    diff.previousTarget === undefined
    || diff.proposedTarget === undefined
    || diff.previousMeals === undefined
    || diff.proposedMeals === undefined
  ) {
    return {
      ...common,
      displayStatus: 'legacy_unavailable' as const,
      displayMessage: '历史餐单差异缺少展示快照，数值记录仍保留；可保留当前餐单，或重新生成后再确认覆盖。' as const
    };
  }
  return {
    ...common,
    displayStatus: 'complete' as const,
    previousNutritionTargetVersionId: diff.previousNutritionTargetVersionId,
    proposedNutritionTargetVersionId: diff.proposedNutritionTargetVersionId,
    previousTarget: { ...diff.previousTarget, fiberRangeG: { ...diff.previousTarget.fiberRangeG } },
    proposedTarget: { ...diff.proposedTarget, fiberRangeG: { ...diff.proposedTarget.fiberRangeG } },
    previousMeals: diff.previousMeals.map((meal) => ({
      ...meal,
      ingredients: meal.ingredients.map((ingredient) => ({ ...ingredient }))
    })),
    proposedMeals: diff.proposedMeals.map((meal) => ({
      ...meal,
      ingredients: meal.ingredients.map((ingredient) => ({ ...ingredient }))
    }))
  };
}

function publicTrainingCompletionEvent(event: TrainingCompletionEvent) {
  return {
    kind: event.kind,
    id: event.id,
    version: event.version,
    trainingPlanVersionId: event.trainingPlanVersionId,
    businessDate: event.businessDate,
    completedDurationMinutes: event.completedDurationMinutes,
    occurredAt: event.occurredAt
  };
}

function publicRecalculationJob(job: RecalculationJob) {
  return {
    kind: job.kind,
    id: job.id,
    triggerEventId: job.triggerEventId,
    triggerType: job.triggerType,
    affectedDates: [...job.affectedDates],
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    candidateMealPlanVersionId: job.candidateMealPlanVersionId,
    activatedMealPlanVersionId: job.activatedMealPlanVersionId,
    failureCode: job.failureCode,
    failureConflictDetailsStatus: job.failureConflictDetailsStatus,
    failureConflicts: job.failureConflicts.map((conflict) => ({ ...conflict }))
  };
}

function publicMealPlanDecision(decision: MealPlanDecision) {
  return {
    kind: decision.kind,
    id: decision.id,
    version: decision.version,
    candidateMealPlanVersionId: decision.candidateMealPlanVersionId,
    previousActiveMealPlanVersionId: decision.previousActiveMealPlanVersionId,
    decision: decision.decision,
    decidedAt: decision.decidedAt,
    activatedMealPlanVersionId: decision.activatedMealPlanVersionId
  };
}

function publicIngredientPhoto(photo: IngredientPhotoVersion) {
  return {
    photoId: photo.photoId,
    revision: photo.revision,
    workflowStatus: photo.workflowStatus,
    storageStatus: photo.storageStatus,
    deleteDueAt: photo.deleteDueAt,
    candidates: photo.candidates.map((candidate) => ({
      id: candidate.id,
      foodId: candidate.foodId,
      canonicalNameZh: candidate.canonicalNameZh,
      confidence: candidate.confidence,
      foodState: candidate.foodState
    })),
    confirmedCandidateId: photo.confirmedCandidateId,
    inventoryVersionId: photo.inventoryVersionId
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
    selectableRecipesStatus: context.selectableRecipesStatus,
    retryableRecalculationJob: context.retryableRecalculationJob === null
      ? null
      : publicRecalculationJob(context.retryableRecalculationJob),
    ingredientPhoto: context.ingredientPhoto === null
      ? null
      : publicIngredientPhoto(context.ingredientPhoto),
    latestVersions: context.latestVersions
  };
}

function errorResponse(
  code: Extract<PlanningApiResponse, { success: false }>['error']['code'],
  message: string,
  conflicts?: readonly PublicWeeklyMealConflict[]
): PlanningApiResponse {
  if (code === 'nutrition_constraints_infeasible') {
    return { success: false, error: { code, message, conflicts: [...(conflicts ?? [])] } };
  }
  return { success: false, error: { code, message } };
}

function publicWeeklyMealConflicts(
  conflicts: NutritionConstraintsInfeasibleError['conflicts']
): readonly PublicWeeklyMealConflict[] {
  return conflicts.map((conflict): PublicWeeklyMealConflict => ({ ...conflict }));
}

function hasPersonalDataService(service: HandlerPlanningService): service is PlanningApiService {
  return 'getPersonalDataSummary' in service
    && 'exportPersonalData' in service
    && 'deleteAccount' in service;
}

async function executeAuthenticatedAction(
  request: Exclude<
    ReturnType<typeof planningApiRequestSchema.parse>,
    { action: 'health' | 'previewDailyEnergy' }
  >,
  context: TrustedRequestContext,
  service: HandlerPlanningService
): Promise<PlanningApiResponse> {
  if (request.action === 'getPersonalDataSummary') {
    if (!hasPersonalDataService(service)) throw new Error('Personal data service is unavailable');
    return {
      success: true,
      data: await service.getPersonalDataSummary(context.userId)
    };
  }
  if (request.action === 'exportPersonalData') {
    if (!hasPersonalDataService(service)) throw new Error('Personal data service is unavailable');
    return planningApiResponseSchema.parse({
      success: true,
      data: await service.exportPersonalData(context.userId, request.snapshotToken)
    });
  }
  if (request.action === 'deleteAccount') {
    if (!hasPersonalDataService(service)) throw new Error('Personal data service is unavailable');
    return {
      success: true,
      data: await service.deleteAccount(context.userId, request.payload)
    };
  }
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
        dailyNutritionTargets: result.dailyNutritionTargets.map(publicDailyNutritionTarget),
        recalculationJob: 'recalculationJob' in result
          && isRecalculationJob(result.recalculationJob)
          ? publicRecalculationJob(result.recalculationJob)
          : null
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
  if (request.action === 'resizeMealPlanPortion') {
    if (!('resizeMealPlanPortion' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const version = await service.resizeMealPlanPortion(context.userId, request.payload);
    return {
      success: true,
      data: { kind: 'meal_plan_updated', version: publicMealPlan(version) }
    };
  }
  if (request.action === 'recordTrainingCompletion') {
    if (!('recordTrainingCompletion' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const result = await service.recordTrainingCompletion(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'training_completion_recorded',
        event: publicTrainingCompletionEvent(result.event),
        dailyEnergyTargets: result.dailyEnergyTargets.map(publicDailyEnergyTarget),
        dailyNutritionTargets: result.dailyNutritionTargets.map(publicDailyNutritionTarget),
        recalculationJob: result.recalculationJob === null
          ? null
          : publicRecalculationJob(result.recalculationJob),
        candidateMealPlan: result.candidateMealPlan === null
          ? null
          : publicMealPlan(result.candidateMealPlan),
        targetDiffs: result.targetDiffs.map(publicMealPlanTargetDiff),
        recalculationStatus: result.recalculationStatus
      }
    };
  }
  if (request.action === 'decideMealPlanCandidate') {
    if (!('decideMealPlanCandidate' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const result = await service.decideMealPlanCandidate(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'meal_plan_candidate_decided',
        decision: publicMealPlanDecision(result.decision),
        recalculationJob: publicRecalculationJob(result.recalculationJob),
        activatedMealPlan: result.activatedMealPlan === null
          ? null
          : publicMealPlan(result.activatedMealPlan)
      }
    };
  }
  if (request.action === 'retryPendingRecalculation') {
    if (!('retryPendingRecalculation' in service)) {
      throw new ProviderUnavailableError('meal_catalog_unavailable');
    }
    const result = await service.retryPendingRecalculation(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'meal_plan_recalculation_processed',
        recalculationJob: publicRecalculationJob(result.recalculationJob),
        candidateMealPlan: result.candidateMealPlan === null
          ? null
          : publicMealPlan(result.candidateMealPlan),
        activatedMealPlan: result.activatedMealPlan === null
          ? null
          : publicMealPlan(result.activatedMealPlan),
        targetDiffs: result.targetDiffs.map(publicMealPlanTargetDiff)
      }
    };
  }
  if (request.action === 'createIngredientPhotoUpload') {
    if (!('createIngredientPhotoUpload' in service)) {
      throw new ProviderUnavailableError('vision_provider_unavailable');
    }
    const result = await service.createIngredientPhotoUpload(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'ingredient_photo_upload_created',
        photo: publicIngredientPhoto(result.photo),
        cloudPath: result.cloudPath
      }
    };
  }
  if (request.action === 'registerIngredientPhotoUpload') {
    if (!('registerIngredientPhotoUpload' in service)) {
      throw new ProviderUnavailableError('vision_provider_unavailable');
    }
    const result = await service.registerIngredientPhotoUpload(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'ingredient_photo_upload_registered',
        photo: publicIngredientPhoto(result.photo)
      }
    };
  }
  if (request.action === 'recognizeIngredientPhoto') {
    if (!('recognizeIngredientPhoto' in service)) {
      throw new ProviderUnavailableError('vision_provider_unavailable');
    }
    const result = await service.recognizeIngredientPhoto(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'ingredient_photo_recognized',
        photo: publicIngredientPhoto(result.photo)
      }
    };
  }
  if (request.action === 'confirmIngredientCandidate') {
    if (!('confirmIngredientCandidate' in service)) {
      throw new ProviderUnavailableError('vision_provider_unavailable');
    }
    const result = await service.confirmIngredientCandidate(context.userId, request.payload);
    return {
      success: true,
      data: {
        kind: 'ingredient_candidate_confirmed',
        photo: publicIngredientPhoto(result.photo),
        inventory: publicInventory(result.inventory)
      }
    };
  }
  const current = await service.getCurrentContext(context.userId);
  return { success: true, data: currentContextResponse(current) };
}

async function handlePlanningApiResult(
  input: unknown,
  context: TrustedRequestContext | undefined,
  service: HandlerPlanningService
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
    if (error instanceof AccountDeletionPendingError) {
      return errorResponse(
        'account_deletion_pending',
        '账户正在删除，请重试删除操作或联系隐私支持。'
      );
    }
    if (error instanceof PersonalDataSnapshotConflictError) {
      return errorResponse(error.code, '个人数据已变化，请刷新摘要后重试。');
    }
    if (error instanceof AccountCapacityExceededError) {
      return errorResponse(error.code, '个人数据量超出自助处理范围，请联系隐私支持。');
    }
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
    if (error instanceof FutureCompletionForbiddenError) {
      return errorResponse(error.code, '训练完成记录不能填写未来日期。');
    }
    if (error instanceof TrainingDateOutsideGoalPeriodError) {
      return errorResponse(error.code, '训练日期必须位于当前目标周期内。');
    }
    if (error instanceof UnknownTrainingSessionError) {
      return errorResponse(error.code, '训练会话缺少已审核的 MET 映射。');
    }
    if (error instanceof ProviderUnavailableError) {
      return errorResponse(
        error.code,
        error.reason === 'vision_provider_unavailable'
          ? '图片识别暂时不可用，请手动录入。'
          : '营养数据暂时不可用。'
      );
    }
    if (error instanceof StorageUnavailableError || hasStableErrorCode(error, 'storage_unavailable')) {
      return errorResponse(
        'storage_unavailable',
        parsed.data.action === 'deleteAccount'
          ? '账户删除暂未完成，请使用同一删除请求重试。'
          : '图片存储暂时不可用，请重新选择图片。'
      );
    }
    if (
      error instanceof IngredientPhotoNotFoundError
      || error instanceof PrivatePhotoOwnershipError
      || error instanceof CandidateConfirmationRequiredError
    ) {
      return errorResponse(
        'candidate_confirmation_required',
        '图片会话或候选不可用，请重新选择图片。'
      );
    }
    if (error instanceof RecipeNotSelectableError) {
      return errorResponse(error.code, '请选择当前上下文提供的备选菜品。');
    }
    if (error instanceof CandidateNotPendingError) {
      return errorResponse(error.code, '餐单候选已处理或不再等待确认。');
    }
    if (error instanceof CandidateDiffUnavailableError) {
      return errorResponse(
        error.code,
        '历史餐单差异缺少安全摘要，不能覆盖锁定日；请保留当前餐单或重新生成。'
      );
    }
    if (error instanceof NutritionConstraintsInfeasibleError) {
      return errorResponse(
        error.code,
        '当前食材与营养目标无法生成可行的一周餐单。',
        publicWeeklyMealConflicts(error.conflicts)
      );
    }
    return errorResponse('internal_error', '规划服务暂时不可用。');
  }
}

export function createPlanningApiHandler(service: HandlerPlanningService) {
  return async (
    input: unknown,
    context?: TrustedRequestContext
  ): Promise<PlanningApiResponse> => planningApiResponseSchema.parse(
    await handlePlanningApiResult(input, context, service)
  );
}

export const handlePlanningApi = createPlanningApiHandler(planningService);
