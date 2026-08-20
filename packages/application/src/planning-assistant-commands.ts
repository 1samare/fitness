import { addBusinessDays } from '@fitness/contracts';
import type {
  AssistantValidatedCommand,
  BodyProfilePayload,
  MealSlot,
  TrainingPlanPayload,
  WriteCommandEnvelope
} from '@fitness/domain';
import { businessDateAt } from './business-time';

export interface PlanningAssistantContext {
  readonly bodyProfile: {
    readonly payload: Pick<BodyProfilePayload, 'businessTimezone'>;
  } | null;
  readonly trainingPlan: {
    readonly version: number;
    readonly payload: TrainingPlanPayload;
  } | null;
  readonly mealPlan: { readonly version: number } | null;
  readonly selectableRecipes: readonly {
    readonly recipeTemplateVersionId: string;
    readonly dishNameZh: string;
  }[];
  readonly selectableRecipesStatus?: 'available' | 'no_options' | 'provider_unavailable';
  readonly latestVersions: {
    readonly trainingPlan: number;
    readonly mealPlan: number;
  };
}

export interface PlanningAssistantCommandPort {
  getCurrentContext(userId: string): Promise<PlanningAssistantContext>;
  saveTrainingPlan(
    userId: string,
    envelope: WriteCommandEnvelope<TrainingPlanPayload>
  ): Promise<unknown>;
  updateMealPlanDay(
    userId: string,
    envelope: WriteCommandEnvelope<{
      readonly businessDate: string;
      readonly slot: MealSlot;
      readonly recipeTemplateVersionId: string;
    }>
  ): Promise<unknown>;
  resizeMealPlanPortion(
    userId: string,
    envelope: WriteCommandEnvelope<{
      readonly businessDate: string;
      readonly slot: MealSlot;
      readonly multiplier: number;
    }>
  ): Promise<unknown>;
}

export type AssistantCommandRejectionReason =
  | 'planning_context_unavailable'
  | 'same_training_date'
  | 'training_date_outside_active_week'
  | 'past_fact_immutable'
  | 'source_training_session_missing'
  | 'target_training_session_occupied'
  | 'recipe_not_selectable'
  | 'recipe_name_ambiguous'
  | 'version_conflict'
  | 'provider_unavailable'
  | 'nutrition_constraints_infeasible'
  | 'internal_error';

const rejectionMessages: Readonly<Record<AssistantCommandRejectionReason, string>> = {
  planning_context_unavailable: '请先在结构化页面完成身体档案、目标和本周计划。',
  same_training_date: '原训练日和目标训练日不能相同。',
  training_date_outside_active_week: '训练只能在当前计划周内移动。',
  past_fact_immutable: '今天及过去日期的计划事实不可修改。',
  source_training_session_missing: '原日期没有且仅有一项可移动训练。',
  target_training_session_occupied: '目标日期已有训练，不能自动覆盖。',
  recipe_not_selectable: '菜品不在当前可选列表中，请返回餐单页选择。',
  recipe_name_ambiguous: '当前有同名菜品，请返回餐单页选择具体菜品。',
  version_conflict: '计划已发生变化，请刷新后重试。',
  provider_unavailable: '计划数据暂时不可用，请稍后重试或使用结构化页面。',
  nutrition_constraints_infeasible: '该修改无法同时满足营养、库存和安全约束。',
  internal_error: '计划修改未完成，请返回结构化页面重试。'
};

export class AssistantCommandError extends Error {
  public readonly code = 'assistant_command_rejected' as const;

  public constructor(public readonly reason: AssistantCommandRejectionReason) {
    super(rejectionMessages[reason]);
    this.name = 'AssistantCommandError';
  }
}

export interface PlanningAssistantCommandService {
  execute(
    userId: string,
    command: AssistantValidatedCommand,
    idempotencyKey: string
  ): Promise<{
    readonly command: AssistantValidatedCommand['kind'];
    readonly message: string;
  }>;
}

export interface PlanningAssistantCommandServiceDependencies {
  readonly planning: PlanningAssistantCommandPort;
  readonly now: () => string;
}

function reject(reason: AssistantCommandRejectionReason): never {
  throw new AssistantCommandError(reason);
}

function mapPlanningError(error: unknown): AssistantCommandError {
  if (error instanceof AssistantCommandError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (code === 'version_conflict' || code === 'idempotency_key_reused') {
    return new AssistantCommandError('version_conflict');
  }
  if (code === 'past_fact_immutable' || code === 'past_training_change_forbidden') {
    return new AssistantCommandError('past_fact_immutable');
  }
  if (code === 'provider_unavailable') {
    return new AssistantCommandError('provider_unavailable');
  }
  if (code === 'nutrition_constraints_infeasible') {
    return new AssistantCommandError('nutrition_constraints_infeasible');
  }
  if (code === 'recipe_not_selectable') {
    return new AssistantCommandError('recipe_not_selectable');
  }
  if (code === 'planning_prerequisite_missing') {
    return new AssistantCommandError('planning_context_unavailable');
  }
  return new AssistantCommandError('internal_error');
}

function activeWeekDates(weekStartDate: string): ReadonlySet<string> {
  return new Set(Array.from({ length: 7 }, (_unused, index) => (
    addBusinessDays(weekStartDate, index)
  )));
}

export function createPlanningAssistantCommandService(
  dependencies: PlanningAssistantCommandServiceDependencies
): PlanningAssistantCommandService {
  const { planning, now } = dependencies;
  return {
    async execute(userId, command, idempotencyKey) {
      try {
        const current = await planning.getCurrentContext(userId);
        if (command.kind === 'move_training_day') {
          const profile = current.bodyProfile;
          const trainingPlan = current.trainingPlan;
          if (profile === null || trainingPlan === null) {
            reject('planning_context_unavailable');
          }
          if (command.sourceDate === command.targetDate) reject('same_training_date');
          const weekDates = activeWeekDates(trainingPlan.payload.weekStartDate);
          if (!weekDates.has(command.sourceDate) || !weekDates.has(command.targetDate)) {
            reject('training_date_outside_active_week');
          }
          const today = businessDateAt(now(), profile.payload.businessTimezone);
          if (command.sourceDate <= today || command.targetDate <= today) {
            reject('past_fact_immutable');
          }
          const sourceSessions = trainingPlan.payload.sessions.filter(
            (session) => session.businessDate === command.sourceDate
          );
          if (sourceSessions.length !== 1) reject('source_training_session_missing');
          if (trainingPlan.payload.sessions.some(
            (session) => session.businessDate === command.targetDate
          )) reject('target_training_session_occupied');
          const source = sourceSessions[0];
          if (source === undefined) reject('source_training_session_missing');
          const sessions = trainingPlan.payload.sessions.map((session) => (
            session === source
              ? { ...session, businessDate: command.targetDate }
              : session
          )).sort((left, right) => (
            left.businessDate.localeCompare(right.businessDate)
            || left.sessionCode.localeCompare(right.sessionCode)
          ));
          await planning.saveTrainingPlan(userId, {
            expectedVersion: current.latestVersions.trainingPlan,
            idempotencyKey,
            payload: { ...trainingPlan.payload, sessions }
          });
          return {
            command: command.kind,
            message: '训练日已移动；后续营养目标会按既有规则重算，锁定餐单差异仍需确认。'
          };
        }

        if (current.mealPlan === null) reject('planning_context_unavailable');
        if (command.kind === 'replace_meal') {
          const matches = current.selectableRecipes.filter(
            (recipe) => recipe.dishNameZh === command.dishNameZh
          );
          if (matches.length === 0) {
            reject(current.selectableRecipesStatus === 'provider_unavailable'
              ? 'provider_unavailable'
              : 'recipe_not_selectable');
          }
          if (matches.length !== 1) reject('recipe_name_ambiguous');
          const selected = matches[0];
          if (selected === undefined) reject('recipe_not_selectable');
          await planning.updateMealPlanDay(userId, {
            expectedVersion: current.latestVersions.mealPlan,
            idempotencyKey,
            payload: {
              businessDate: command.businessDate,
              slot: command.slot,
              recipeTemplateVersionId: selected.recipeTemplateVersionId
            }
          });
          return {
            command: command.kind,
            message: '菜品已替换，并已重新校验营养、库存、来源和过敏原约束。'
          };
        }

        await planning.resizeMealPlanPortion(userId, {
          expectedVersion: current.latestVersions.mealPlan,
          idempotencyKey,
          payload: {
            businessDate: command.businessDate,
            slot: command.slot,
            multiplier: command.multiplier
          }
        });
        return {
          command: command.kind,
          message: '份量已调整，并已重新计算克数与营养、库存和安全约束。'
        };
      } catch (error: unknown) {
        throw mapPlanningError(error);
      }
    }
  };
}
