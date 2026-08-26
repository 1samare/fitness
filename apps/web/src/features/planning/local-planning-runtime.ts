import {
  NutritionConstraintsInfeasibleError,
  PlanningPrerequisiteError,
  ProviderUnavailableError,
  VersionConflictError,
  createMealPlanRecalculationService
} from '@fitness/application/browser';
import {
  type FitnessLocalDatabase,
  LOCAL_USER_ID
} from '../../db/database';
import { DexiePlanningRepository } from '../../db/dexie-planning-repository';
import { LocalRevisionConflictError } from '../../db/errors';
import { initializeLocalData } from '../../db/initialize-local-data';
import {
  createLocalMealPlanningProviders,
  readLocalTestFoods
} from '../meals/local-meal-providers';
import {
  buildPlanningSetupPayload,
  type PlanningSetupFormInput
} from './planning-form';

type PlanningService = ReturnType<typeof createMealPlanRecalculationService>;
export type LocalPlanningContext = Awaited<ReturnType<PlanningService['getCurrentContext']>>;

export interface LocalTestFoodOption {
  readonly foodId: string;
  readonly canonicalNameZh: string;
  readonly nutritionSnapshotId: string;
  readonly foodState: 'raw' | 'cooked' | 'dry';
}

export interface LocalPlanningSnapshot {
  readonly setupConfirmed: boolean;
  readonly setupConfirmedAt: string | null;
  readonly context: LocalPlanningContext;
  readonly testFoods: readonly LocalTestFoodOption[];
}

export type LocalPlanningFlowErrorCode =
  | 'test_boundary_confirmation_required'
  | 'planning_form_invalid'
  | 'planning_version_changed'
  | 'planning_prerequisite_missing'
  | 'provider_unavailable'
  | 'nutrition_constraints_infeasible';

export class LocalPlanningFlowError extends Error {
  public constructor(
    public readonly code: LocalPlanningFlowErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LocalPlanningFlowError';
  }
}

export interface LocalPlanningRuntimeOptions {
  readonly database: FitnessLocalDatabase;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
  readonly nextIdempotencyKey?: () => string;
}

export interface LocalPlanningRuntime {
  readonly businessToday: string;
  readonly snapshot: LocalPlanningSnapshot;
  initialize(): Promise<LocalPlanningSnapshot>;
  refresh(): Promise<LocalPlanningSnapshot>;
  confirmTestBoundary(): Promise<LocalPlanningSnapshot>;
  submitSetup(form: PlanningSetupFormInput): Promise<LocalPlanningSnapshot>;
  saveInventory(items: readonly { readonly name: string; readonly availableGrams: number }[]): Promise<LocalPlanningSnapshot>;
  generateMealPlan(): Promise<LocalPlanningSnapshot>;
  setMealPlanDayLock(businessDate: string, locked: boolean): Promise<LocalPlanningSnapshot>;
  replaceMeal(businessDate: string, slot: 'breakfast' | 'lunch' | 'dinner' | 'snack', recipeTemplateVersionId: string): Promise<LocalPlanningSnapshot>;
  resizeMealPortion(businessDate: string, slot: 'breakfast' | 'lunch' | 'dinner' | 'snack', multiplier: number): Promise<LocalPlanningSnapshot>;
  moveTrainingSession(fromBusinessDate: string, toBusinessDate: string): Promise<LocalPlanningSnapshot>;
  recordTrainingCompletion(businessDate: string, completedDurationMinutes: number): Promise<LocalPlanningSnapshot>;
  decidePendingMealPlan(decision: 'keep_existing' | 'overwrite_locked'): Promise<LocalPlanningSnapshot>;
  retryPendingRecalculation(): Promise<LocalPlanningSnapshot>;
}

function browserId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createLocalPlanningRuntime(
  options: LocalPlanningRuntimeOptions
): LocalPlanningRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const repository = new DexiePlanningRepository(options.database);
  const service = createMealPlanRecalculationService({
    repository,
    now,
    nextId: options.nextId ?? browserId,
    providers: createLocalMealPlanningProviders(options.database)
  });
  const nextIdempotencyKey = options.nextIdempotencyKey
    ?? (() => browserId('web-command'));
  let currentSnapshot: LocalPlanningSnapshot | null = null;

  async function readSnapshot(): Promise<LocalPlanningSnapshot> {
    const [settings, context, testFoods] = await Promise.all([
      options.database.appSettings.get(LOCAL_USER_ID),
      service.getCurrentContext(LOCAL_USER_ID),
      readLocalTestFoods(options.database)
    ]);
    if (settings === undefined) throw new Error('Local application settings are missing');
    currentSnapshot = {
      setupConfirmed: settings.setupConfirmedAt !== null,
      setupConfirmedAt: settings.setupConfirmedAt,
      context,
      testFoods
    };
    return currentSnapshot;
  }

  const runtime: LocalPlanningRuntime = {
    businessToday: now().slice(0, 10),

    get snapshot(): LocalPlanningSnapshot {
      if (currentSnapshot === null) throw new Error('Local planning runtime is not initialized');
      return currentSnapshot;
    },

    async initialize(): Promise<LocalPlanningSnapshot> {
      await initializeLocalData(options.database, now());
      return readSnapshot();
    },

    refresh: readSnapshot,

    async confirmTestBoundary(): Promise<LocalPlanningSnapshot> {
      const confirmedAt = now();
      const updated = await options.database.appSettings.update(LOCAL_USER_ID, {
        setupConfirmedAt: confirmedAt,
        updatedAt: confirmedAt
      });
      if (updated !== 1) throw new Error('Local application settings are missing');
      return readSnapshot();
    },

    async submitSetup(form: PlanningSetupFormInput): Promise<LocalPlanningSnapshot> {
      if (!runtime.snapshot.setupConfirmed) {
        throw new LocalPlanningFlowError(
          'test_boundary_confirmation_required',
          '请先确认仅使用虚拟数据、非医疗用途和本地存储边界。'
        );
      }
      const built = buildPlanningSetupPayload(form);
      if (built.kind === 'invalid') {
        throw new LocalPlanningFlowError('planning_form_invalid', built.message);
      }
      const versions = runtime.snapshot.context.latestVersions;
      return executeWrite(async () => {
        await service.completePlanningSetup(LOCAL_USER_ID, {
          expectedVersions: {
            bodyProfile: versions.bodyProfile,
            goal: versions.goal,
            trainingPlan: versions.trainingPlan
          },
          idempotencyKey: nextIdempotencyKey(),
          ...built.payload
        });
      });
    },

    saveInventory: (items) => executeWrite(() => service.saveInventory(LOCAL_USER_ID, {
      expectedVersion: runtime.snapshot.context.latestVersions.inventory,
      idempotencyKey: nextIdempotencyKey(),
      payload: { items }
    })),

    generateMealPlan: () => executeWrite(() => {
      const weekStartDate = runtime.snapshot.context.trainingPlan?.payload.weekStartDate;
      if (weekStartDate === undefined) {
        throw new LocalPlanningFlowError(
          'planning_prerequisite_missing',
          '请先完成结构化训练计划。'
        );
      }
      return service.generateWeeklyMealPlan(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.mealPlan,
        idempotencyKey: nextIdempotencyKey(),
        payload: { weekStartDate }
      });
    }),

    setMealPlanDayLock: (businessDate, locked) => executeWrite(() => (
      service.setMealPlanDayLock(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.mealPlan,
        idempotencyKey: nextIdempotencyKey(),
        payload: { businessDate, locked }
      })
    )),

    replaceMeal: (businessDate, slot, recipeTemplateVersionId) => executeWrite(() => (
      service.updateMealPlanDay(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.mealPlan,
        idempotencyKey: nextIdempotencyKey(),
        payload: { businessDate, slot, recipeTemplateVersionId }
      })
    )),

    resizeMealPortion: (businessDate, slot, multiplier) => executeWrite(() => (
      service.resizeMealPlanPortion(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.mealPlan,
        idempotencyKey: nextIdempotencyKey(),
        payload: { businessDate, slot, multiplier }
      })
    )),

    moveTrainingSession: (fromBusinessDate, toBusinessDate) => executeWrite(() => {
      const plan = runtime.snapshot.context.trainingPlan;
      if (plan === null) {
        throw new LocalPlanningFlowError('planning_prerequisite_missing', '请先完成训练计划。');
      }
      const source = plan.payload.sessions.find((session) => (
        session.businessDate === fromBusinessDate
      ));
      if (source === undefined) {
        throw new LocalPlanningFlowError('planning_form_invalid', '原日期没有可移动的训练。');
      }
      if (plan.payload.sessions.some((session) => session.businessDate === toBusinessDate)) {
        throw new LocalPlanningFlowError('planning_form_invalid', '目标日期已经有训练。');
      }
      const sessions = plan.payload.sessions
        .map((session) => session.businessDate === fromBusinessDate
          ? { ...session, businessDate: toBusinessDate }
          : session)
        .sort((left, right) => left.businessDate.localeCompare(right.businessDate));
      return service.saveTrainingPlan(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.trainingPlan,
        idempotencyKey: nextIdempotencyKey(),
        payload: { ...plan.payload, sessions }
      });
    }),

    recordTrainingCompletion: (businessDate, completedDurationMinutes) => executeWrite(() => (
      service.recordTrainingCompletion(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.trainingCompletion,
        idempotencyKey: nextIdempotencyKey(),
        payload: { businessDate, completedDurationMinutes }
      })
    )),

    decidePendingMealPlan: (decision) => executeWrite(() => {
      const candidate = runtime.snapshot.context.pendingMealPlanCandidate;
      if (candidate === null) {
        throw new LocalPlanningFlowError('planning_prerequisite_missing', '当前没有待确认餐单。');
      }
      return service.decideMealPlanCandidate(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.mealPlanDecision,
        idempotencyKey: nextIdempotencyKey(),
        payload: { candidateMealPlanVersionId: candidate.id, decision }
      });
    }),

    retryPendingRecalculation: () => executeWrite(() => {
      const job = runtime.snapshot.context.retryableRecalculationJob;
      if (job === null) {
        throw new LocalPlanningFlowError('planning_prerequisite_missing', '当前没有可重试任务。');
      }
      return service.retryPendingRecalculation(LOCAL_USER_ID, {
        expectedVersion: runtime.snapshot.context.latestVersions.recalculationJob,
        idempotencyKey: nextIdempotencyKey(),
        payload: { recalculationJobId: job.id }
      });
    })
  };

  async function executeWrite(action: () => Promise<unknown>): Promise<LocalPlanningSnapshot> {
    try {
      await action();
      return await readSnapshot();
    } catch (error: unknown) {
      await readSnapshot();
      if (error instanceof VersionConflictError || error instanceof LocalRevisionConflictError) {
        throw new LocalPlanningFlowError(
          'planning_version_changed',
          '另一标签页已更新规划；已刷新到最新版本，请复核后再次提交。'
        );
      }
      if (error instanceof ProviderUnavailableError) {
        throw new LocalPlanningFlowError(
          'provider_unavailable',
          '本地测试数据暂时不可用；当前计划仍可查看，请恢复数据集后重试。'
        );
      }
      if (error instanceof NutritionConstraintsInfeasibleError) {
        const conflictCodes = [...new Set(error.conflicts.map((conflict) => conflict.code))];
        throw new LocalPlanningFlowError(
          'nutrition_constraints_infeasible',
          `当前库存无法同时满足营养与安全约束（${conflictCodes.join('、')}）。`
        );
      }
      if (error instanceof PlanningPrerequisiteError) {
        throw new LocalPlanningFlowError(
          'planning_prerequisite_missing',
          '请先完成前置规划步骤。'
        );
      }
      throw error;
    }
  }
  return runtime;
}
