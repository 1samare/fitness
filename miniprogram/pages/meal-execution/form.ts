import type { PlanningApiRequest } from '@fitness/contracts';

type RequestFor<TAction extends PlanningApiRequest['action']> = Extract<
  PlanningApiRequest,
  { action: TAction }
>;

export interface InventoryRowInput {
  readonly name: string;
  readonly availableGrams: string;
}

export interface SelectableRecipeInput {
  readonly recipeTemplateVersionId: string;
  readonly dishNameZh: string;
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type CandidateDecision = 'keep_existing' | 'overwrite_locked';

function fail(message: string): never {
  throw new Error(message);
}

function normalizeVisibleName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function validBusinessDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function requireBusinessDate(value: string): string {
  if (!validBusinessDate(value)) fail('请选择有效业务日期');
  return value;
}

function requireBusinessToday(value: string): string {
  if (!validBusinessDate(value)) fail('当前业务日期无效，请刷新页面');
  return value;
}

function requireExpectedVersion(value: number): number {
  if (!Number.isInteger(value) || value < 0) fail('规划版本已失效，请刷新后重试');
  return value;
}

function requireIdempotencyKey(value: string): string {
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    fail('提交标识无效，请刷新后重试');
  }
  return value;
}

function requireContextIdentifier(value: string, message: string): string {
  if (value.length < 1 || value.length > 200) fail(message);
  return value;
}

function writeEnvelope<TPayload>(input: {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
}) {
  return {
    expectedVersion: requireExpectedVersion(input.expectedVersion),
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    payload: input.payload
  };
}

export function buildResolveFoodNameRequest(name: string): RequestFor<'resolveFoodName'> {
  const normalizedName = normalizeVisibleName(name);
  if (normalizedName.length === 0) fail('请填写食材名称');
  if (normalizedName.length > 120) fail('食材名称不能超过 120 个字符');
  return { action: 'resolveFoodName', payload: { name: normalizedName } };
}

export function buildInventoryRequest(input: {
  readonly rows: readonly InventoryRowInput[];
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'saveInventory'> {
  if (input.rows.length === 0 || input.rows.length > 200) {
    fail('请填写 1–200 行食材库存');
  }
  const normalizedNames = new Set<string>();
  const items = input.rows.map((row, index) => {
    const name = normalizeVisibleName(row.name);
    if (name.length === 0) fail(`请填写第 ${String(index + 1)} 行食材名称`);
    if (name.length > 120) fail(`第 ${String(index + 1)} 行食材名称不能超过 120 个字符`);
    const duplicateKey = name.toLocaleLowerCase('zh-CN');
    if (normalizedNames.has(duplicateKey)) fail('食材名称不能重复');
    normalizedNames.add(duplicateKey);

    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(row.availableGrams.trim())) {
      fail(`第 ${String(index + 1)} 行请输入有效克数`);
    }
    const availableGrams = Number(row.availableGrams);
    if (availableGrams <= 0) fail(`第 ${String(index + 1)} 行克数必须大于 0`);
    if (availableGrams > 1_000_000) fail(`第 ${String(index + 1)} 行克数不能超过 1000000`);
    return { name, availableGrams };
  });
  return {
    action: 'saveInventory',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: { items }
    })
  };
}

export function buildGenerateMealPlanRequest(input: {
  readonly weekStartDate: string;
  readonly businessToday: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'generateWeeklyMealPlan'> {
  const weekStartDate = requireBusinessDate(input.weekStartDate);
  const businessToday = requireBusinessToday(input.businessToday);
  if (weekStartDate < businessToday) fail('请选择今天或未来开始的一周');
  return {
    action: 'generateWeeklyMealPlan',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: { weekStartDate }
    })
  };
}

export function buildLockRequest(input: {
  readonly businessDate: string;
  readonly businessToday: string;
  readonly locked: boolean;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'setMealPlanDayLock'> {
  const businessDate = requireBusinessDate(input.businessDate);
  if (businessDate <= requireBusinessToday(input.businessToday)) {
    fail('今天及过去日期的餐单事实不可修改');
  }
  return {
    action: 'setMealPlanDayLock',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: { businessDate, locked: input.locked }
    })
  };
}

export function buildRecipeEditRequest(input: {
  readonly businessDate: string;
  readonly businessToday: string;
  readonly slot: MealSlot;
  readonly selectedRecipeIndex: number;
  readonly recipeOptions: readonly SelectableRecipeInput[];
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'updateMealPlanDay'> {
  const businessDate = requireBusinessDate(input.businessDate);
  if (businessDate <= requireBusinessToday(input.businessToday)) {
    fail('今天及过去日期的餐单事实不可修改');
  }
  if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(input.slot)) {
    fail('请选择有效餐次');
  }
  const selected = input.recipeOptions[input.selectedRecipeIndex];
  if (selected === undefined) fail('请选择服务端提供的备选菜品');
  return {
    action: 'updateMealPlanDay',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: {
        businessDate,
        slot: input.slot,
        recipeTemplateVersionId: requireContextIdentifier(
          selected.recipeTemplateVersionId,
          '备选菜品已失效，请刷新后重试'
        )
      }
    })
  };
}

export function buildCompletionRequest(input: {
  readonly businessDate: string;
  readonly businessToday: string;
  readonly completedDurationMinutes: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'recordTrainingCompletion'> {
  const businessDate = requireBusinessDate(input.businessDate);
  if (businessDate > requireBusinessToday(input.businessToday)) fail('不能记录未来日期');
  if (!/^\d+$/.test(input.completedDurationMinutes.trim())) {
    fail('完成分钟数须为 0–300 的整数');
  }
  const completedDurationMinutes = Number(input.completedDurationMinutes);
  if (completedDurationMinutes < 0 || completedDurationMinutes > 300) {
    fail('完成分钟数须为 0–300 的整数');
  }
  return {
    action: 'recordTrainingCompletion',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: { businessDate, completedDurationMinutes }
    })
  };
}

export function buildCandidateDecisionRequest(input: {
  readonly candidateMealPlanVersionId: string;
  readonly decision: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'decideMealPlanCandidate'> {
  if (input.decision !== 'keep_existing' && input.decision !== 'overwrite_locked') {
    fail('请选择保留原餐单或覆盖锁定日');
  }
  return {
    action: 'decideMealPlanCandidate',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: {
        candidateMealPlanVersionId: requireContextIdentifier(
          input.candidateMealPlanVersionId,
          '待确认餐单已失效，请刷新后重试'
        ),
        decision: input.decision
      }
    })
  };
}

export function buildRetryRequest(input: {
  readonly recalculationJobId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}): RequestFor<'retryPendingRecalculation'> {
  return {
    action: 'retryPendingRecalculation',
    payload: writeEnvelope({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: {
        recalculationJobId: requireContextIdentifier(
          input.recalculationJobId,
          '重算任务已失效，请刷新后重试'
        )
      }
    })
  };
}
