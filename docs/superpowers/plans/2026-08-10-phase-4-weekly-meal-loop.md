# Phase 4 Weekly Meal Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete phase 4 with versioned manual inventory, deterministic seven-day meal generation, day-level protection, training/completion-driven recalculation, strict API/runtime persistence, and a usable native WeChat meal-execution flow.

**Architecture:** Extend the existing per-user planning aggregate from schema v3 to v4 so inventory, meal plans, completion facts, diffs, decisions, recalculation jobs, and active pointers share the existing atomic repository boundary. Keep generation and nutrient recomputation pure in `@fitness/calculation`; load runtime-validated reviewed records through provider ports outside transactions, then compare exact active version IDs inside the transaction before committing complete immutable successors.

**Tech Stack:** TypeScript 5.9 strict mode, Zod 4, Vitest 3, pnpm 9 workspaces, CloudBase Node.js cloud functions, native WeChat Mini Program, existing esbuild/tsup build chain.

## Global Constraints

- Work only on `feat/v1.0`; do not create a branch or worktree and do not merge `phase1-local`.
- Do not install dependencies or call live/paid nutrition, model, or vision APIs.
- Preserve the dependency direction page → API → application → domain/calculation → provider adapter.
- Only deterministic TypeScript produces calories, grams, percentages, serving multipliers, and nutrient totals.
- Allergens, avoid foods, source quality, inventory, nutrition feasibility, and food diversity are hard constraints and never relax.
- Automatic personalized energy remains limited to age `18–45`, BMI `18.5–<24.0`, confirmed minimum health exclusions, and complete required inputs under `calculation-policy-v2`.
- Use `weekly-meal-generation-v1`, `meal-plan-validation-v1`, `food-diversity-policy-v1`, `nutrition-policy-v1`, and immutable source/version references exactly as specified by `docs/superpowers/specs/2026-08-10-phase-4-weekly-meal-loop-design.md`.
- Production mode rejects `qualityStatus: "test_fixture"`; local/test fixtures remain conspicuously synthetic.
- Every write uses trusted server identity, expected version, and an idempotency key. Clients never submit trusted `userId`, MET, nutrient totals, source status, or active pointers.
- Past facts are immutable. A future completion is rejected; a past completion is recorded without recalculation; today's completion can recalculate only today.
- A locked or manually modified day is never silently overwritten. New meal content becomes active only after the complete successor succeeds.
- Keep the user's untracked `.pnpm-store/` untouched and unstaged.

---

## File Map

- `packages/domain/src/meal-planning.ts`: provider ports, policy metadata, inventory, meal-plan, completion, diff, decision, and job records.
- `packages/domain/src/versioned-planning.ts`: schema-v4 aggregate state, new idempotency variants, current context, and latest-version counters.
- `packages/contracts/src/nutrition.ts`: runtime schemas for menus, catalogs, meal policies, and public nutrient-bearing records.
- `packages/contracts/src/planning-api.ts`: strict request/response and stored aggregate schemas for all phase-4 actions.
- `packages/providers/src/reviewed-nutrition-cache.ts`: exact normalized food-name resolution plus existing snapshot access.
- `packages/providers/src/static-daily-menu-catalog-provider.ts`: runtime-validated fixed catalog/menu adapter with production fixture rejection.
- `data/nutrition-fixtures/src/index.ts`: synthetic 28-food, recipe, menu, and catalog fixtures used only by test/local runtime.
- `packages/calculation/src/meal-plan-policy.ts`: validation/diversity/generation policy objects and constants.
- `packages/calculation/src/generate-weekly-meal-plan.ts`: pure deterministic candidate expansion, nutrient recomputation, inventory search, and structured conflicts.
- `packages/application/src/meal-plan-generation.ts`: provider snapshot loading, generation input assembly, and transaction compare-and-set helpers.
- `packages/application/src/meal-plan-recalculation.ts`: affected-day preservation, locked diffs, candidate processing, and decision helpers.
- `packages/application/src/versioned-planning.ts`: public inventory, meal, lock/edit, completion, event-consumption, retry, and context methods.
- `packages/persistence/src/*.ts`: empty state, schema-v4 migration, and referential/activation invariants.
- `cloudfunctions/planning-api/src/handler.ts`: action dispatch, public DTO mapping, and stable error mapping.
- `cloudfunctions/planning-api/src/runtime-handler.ts`: local fixture providers and fail-closed production provider configuration.
- `miniprogram/pages/meal-execution/*`: inventory, weekly plan, lock/edit, diff decision, and completion UI.
- `tests/e2e/weekly-meal-loop.test.ts`: complete local in-memory acceptance flow.
- `README.md` and `DEVELOPMENT_PROGRESS.md`: implemented behavior, evidence, remaining external gates, and next stage.

---

### Task 1: Phase Start, Reviewed Meal Data, and Runtime Provider Ports

**Files:**
- Modify: `DEVELOPMENT_PROGRESS.md`
- Create: `packages/domain/src/meal-planning.ts`
- Modify: `packages/domain/src/food-nutrition.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/contracts/src/nutrition.ts`
- Modify: `packages/contracts/src/nutrition.test.ts`
- Modify: `packages/providers/src/reviewed-nutrition-cache.ts`
- Modify: `packages/providers/src/reviewed-nutrition-cache.test.ts`
- Create: `packages/providers/src/static-daily-menu-catalog-provider.ts`
- Create: `packages/providers/src/static-daily-menu-catalog-provider.test.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `data/nutrition-fixtures/src/index.ts`
- Modify: `data/nutrition-fixtures/src/index.test.ts`

**Interfaces:**
- Consumes: existing `NutritionDataSnapshot`, `RecipeTemplateVersion`, `NutritionProvider`, `RecipeTemplateProvider`, and `NutrientValues`.
- Produces: `FoodResolution`, extended `NutritionProvider.resolveCanonicalName`, `MealSlot`, `DailyMenuTemplateVersion`, `DailyMenuCatalogVersion`, `DailyMenuCatalogProvider`, `InventoryVersion`, `MealPlanDay`, `MealPlanVersion`, `MealPlanTargetDiff`, `MealPlanDecision`, `TrainingCompletionEvent`, and `RecalculationJob`.

- [ ] **Step 1: Mark phase 4 in progress without checking acceptance boxes**

Change the overview row, “当前下一阶段”, and phase-4 heading from `未开始` to `进行中`. Keep all five phase-4 checkboxes unchecked and retain the existing external-gate text.

- [ ] **Step 2: Write RED schemas and provider tests**

Add tests that import the new symbols before they exist and prove strict validation and production fixture rejection:

```ts
it('validates a fixed daily-menu catalog and rejects extra fields', () => {
  const catalog = dailyMenuCatalogVersionSchema.parse(TEST_DAILY_MENU_CATALOG);
  expect(catalog.dailyMenuTemplateVersionIds).toHaveLength(7);
  expect(() => dailyMenuCatalogVersionSchema.parse({ ...catalog, userId: 'attacker' }))
    .toThrow();
});

it('resolves only normalized exact canonical names', async () => {
  const cache = new ReviewedNutritionCache({ mode: 'test', snapshots: TEST_NUTRITION_SNAPSHOTS });
  await expect(cache.resolveCanonicalName('  测试米饭  ')).resolves.toMatchObject({
    foodId: 'fixture-rice',
    nutritionSnapshotId: 'snapshot-fixture-rice-v1'
  });
  await expect(cache.resolveCanonicalName('测试米')).resolves.toBeNull();
});

it('rejects fixture menus in production mode', async () => {
  const provider = new StaticDailyMenuCatalogProvider({
    mode: 'production',
    catalog: TEST_DAILY_MENU_CATALOG,
    menus: TEST_DAILY_MENU_TEMPLATES
  });
  await expect(provider.getActiveCatalog()).rejects.toMatchObject({
    code: 'daily_menu_catalog_unavailable'
  });
});
```

- [ ] **Step 3: Run provider/schema tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/contracts/src/nutrition.test.ts packages/providers/src/reviewed-nutrition-cache.test.ts packages/providers/src/static-daily-menu-catalog-provider.test.ts data/nutrition-fixtures/src/index.test.ts
```

Expected: FAIL because daily-menu schemas, provider, fixtures, and name-resolution API do not exist.

- [ ] **Step 4: Define exact domain records and provider contracts**

Define `FoodResolution` in `food-nutrition.ts` beside `NutritionProvider`, then create `meal-planning.ts` with the remaining stable shapes and export both files:

```ts
export interface FoodResolution {
  readonly foodId: string;
  readonly canonicalNameZh: string;
  readonly nutritionSnapshotId: string;
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface DailyMenuTemplateVersion {
  readonly id: string;
  readonly datasetVersion: string;
  readonly sourceId: string;
  readonly reviewedAt: string;
  readonly qualityStatus: 'reviewed' | 'test_fixture';
  readonly meals: readonly {
    readonly slot: MealSlot;
    readonly recipeTemplateVersionId: string;
  }[];
}

export interface DailyMenuCatalogVersion {
  readonly id: string;
  readonly datasetVersion: string;
  readonly sourceId: string;
  readonly reviewedAt: string;
  readonly qualityStatus: 'reviewed' | 'test_fixture';
  readonly dailyMenuTemplateVersionIds: readonly string[];
}

export interface DailyMenuCatalogProvider {
  getActiveCatalog(): Promise<DailyMenuCatalogVersion>;
  getMenuByVersionId(versionId: string): Promise<DailyMenuTemplateVersion>;
}
```

Extend `NutritionProvider` exactly once:

```ts
export interface NutritionProvider {
  getSnapshot(snapshotId: string): Promise<NutritionDataSnapshot>;
  resolveCanonicalName(name: string): Promise<FoodResolution | null>;
}
```

Define the remaining immutable records with these exact public field names; activation remains exclusively represented by `activeMealPlanVersionId`:

```ts
export interface InventoryVersion {
  readonly kind: 'inventory_version';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly items: readonly {
    readonly foodId: string;
    readonly nutritionSnapshotId: string;
    readonly availableGrams: number;
  }[];
}

export interface MealAssignment {
  readonly slot: MealSlot;
  readonly recipeTemplateVersionId: string;
  readonly servingMultiplier: number;
}

export interface MealPlanDay {
  readonly businessDate: string;
  readonly dailyNutritionTargetVersionId: string;
  readonly dailyMenuTemplateVersionId: string;
  readonly locked: boolean;
  readonly manuallyModified: boolean;
  readonly meals: readonly MealAssignment[];
  readonly ingredientAmounts: readonly { readonly foodId: string; readonly grams: number }[];
  readonly nutritionTotals: NutrientValues;
  readonly nutritionSourceSnapshotIds: readonly string[];
}

export interface MealPlanVersion {
  readonly kind: 'meal_plan_version';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly weekStartDate: string;
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly inventoryVersionId: string;
  readonly catalogVersionId: string;
  readonly generationPolicyVersion: 'weekly-meal-generation-v1';
  readonly supersedesVersionId: string | null;
  readonly readiness: 'complete' | 'pending_confirmation';
  readonly days: readonly MealPlanDay[];
}

export interface MealPlanTargetDiff {
  readonly id: string;
  readonly userId: string;
  readonly candidateMealPlanVersionId: string;
  readonly businessDate: string;
  readonly previousNutritionTargetVersionId: string;
  readonly proposedNutritionTargetVersionId: string;
  readonly reason: 'locked_or_manually_modified';
}

export interface MealPlanDecision {
  readonly kind: 'meal_plan_decision';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly candidateMealPlanVersionId: string;
  readonly previousActiveMealPlanVersionId: string;
  readonly decision: 'keep_existing' | 'overwrite_locked';
  readonly decidedAt: string;
  readonly activatedMealPlanVersionId: string | null;
}

export interface TrainingCompletionEvent {
  readonly kind: 'training_completion_event';
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly trainingPlanVersionId: string;
  readonly businessDate: string;
  readonly completedDurationMinutes: number;
  readonly occurredAt: string;
}

export interface RecalculationJob {
  readonly kind: 'recalculation_job';
  readonly id: string;
  readonly userId: string;
  readonly triggerEventId: string;
  readonly triggerType: 'training_plan_changed' | 'training_completion';
  readonly affectedDates: readonly string[];
  readonly status: 'pending' | 'completed' | 'failed_retryable';
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly candidateMealPlanVersionId: string | null;
  readonly activatedMealPlanVersionId: string | null;
  readonly failureCode: 'provider_unavailable' | 'nutrition_constraints_infeasible' | null;
}
```

- [ ] **Step 5: Implement strict schemas and static adapters**

Use `.strict()`, ISO datetime schemas, finite nonnegative nutrient fields, serving multipliers constrained to `0.5–1.5`, and unique record-ID checks. The menu schema is:

```ts
export const dailyMenuTemplateVersionSchema = z.object({
  id: traceableIdSchema,
  datasetVersion: traceableIdSchema,
  sourceId: traceableIdSchema,
  reviewedAt: z.iso.datetime(),
  qualityStatus: z.enum(['reviewed', 'test_fixture']),
  meals: z.array(z.object({
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
    recipeTemplateVersionId: traceableIdSchema
  }).strict()).min(3).max(4)
}).strict();
```

Reject duplicate meal slots after parsing. Normalize food names with the existing whitespace/allergen canonicalization pattern:

```ts
function normalizeFoodName(value: string): string {
  return value.trim().replaceAll(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

public resolveCanonicalName(name: string): Promise<FoodResolution | null> {
  const snapshot = this.snapshotsByName.get(normalizeFoodName(name));
  if (snapshot === undefined || (this.mode === 'production' && snapshot.qualityStatus !== 'reviewed')) {
    return Promise.resolve(null);
  }
  return Promise.resolve({
    foodId: snapshot.foodId,
    canonicalNameZh: snapshot.canonicalNameZh,
    nutritionSnapshotId: snapshot.id
  });
}
```

- [ ] **Step 6: Expand conspicuously synthetic local fixtures**

Create exactly 28 snapshot definitions with IDs prefixed `fixture-`, covering grains/tubers, vegetables, fruit, animal protein, soy/nuts, dairy, fats, and other. Use a fixture-only nutrient table and explicit `FITNESS-TEST-FIXTURE-V2` metadata; create at least 28 recipe versions, seven four-meal daily menu versions, and one seven-ID catalog. Every daily menu must reference at least 12 distinct food IDs and five core groups; the seven-menu union must contain all 28 IDs. Add one allergen-conflicting recipe that is never eligible for an allergen profile.

```ts
const TEST_FOOD_KEYS = [
  'rice', 'oats', 'sweet-potato', 'corn',
  'broccoli', 'spinach', 'carrot', 'tomato', 'mushroom', 'cabbage',
  'apple', 'banana', 'orange', 'blueberry',
  'chicken', 'beef', 'egg', 'fish',
  'tofu', 'soybean', 'peanut', 'walnut',
  'milk', 'yogurt',
  'canola-oil', 'sesame-oil',
  'seaweed', 'sesame'
] as const;
```

Fixture tests must prove all references resolve, quality is `test_fixture`, daily and weekly diversity minima hold, and no production adapter returns them.

- [ ] **Step 7: Run focused tests and GREEN verification**

Run the Step 3 command, then:

```powershell
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all commands exit `0`, with no warnings introduced by the new package exports.

- [ ] **Step 8: Commit Task 1**

```powershell
git add DEVELOPMENT_PROGRESS.md packages/domain packages/contracts/src/nutrition.ts packages/contracts/src/nutrition.test.ts packages/providers data/nutrition-fixtures
git commit -m "feat: add reviewed weekly meal data"
```

---

### Task 2: Pure Deterministic Seven-Day Meal Generator

**Files:**
- Create: `packages/calculation/src/meal-plan-policy.ts`
- Create: `packages/calculation/src/generate-weekly-meal-plan.ts`
- Create: `packages/calculation/src/generate-weekly-meal-plan.test.ts`
- Modify: `packages/calculation/src/index.ts`
- Modify: `packages/calculation/src/evaluate-recipe-candidate.ts`
- Modify: `packages/calculation/src/evaluate-recipe-candidate.test.ts`

**Interfaces:**
- Consumes: validated catalogs, menus, recipes, snapshots, `NutritionTargetResult`, inventory snapshot items, profile allergens/avoid IDs, and `roundHalfUp`.
- Produces: `WEEKLY_MEAL_GENERATION_V1`, `MEAL_PLAN_VALIDATION_V1`, `FOOD_DIVERSITY_POLICY_V1`, `WEEKLY_MEAL_SERVING_MULTIPLIERS`, and `generateWeeklyMealPlan(input): WeeklyMealGenerationResult`.

- [ ] **Step 1: Write RED policy, recomputation, search, and failure tests**

Cover one behavior per test. The core expected API is:

```ts
const result = generateWeeklyMealPlan({
  weekStartDate: '2026-08-17',
  targets: sevenNutritionTargets,
  inventory: fixtureInventory,
  allergens: [],
  avoidFoodIds: [],
  catalog: TEST_DAILY_MENU_CATALOG,
  menus: TEST_DAILY_MENU_TEMPLATES,
  recipes: TEST_RECIPE_TEMPLATES,
  snapshots: TEST_NUTRITION_SNAPSHOTS,
  allowTestFixtures: true,
  fixedDays: []
});
expect(result).toMatchObject({ kind: 'generated', policyVersion: 'weekly-meal-generation-v1' });
if (result.kind === 'generated') expect(result.days).toHaveLength(7);
```

Implement these independently named test cases, and assert each failure includes its exact date and stable conflict code:

- multipliers equal exactly `0.50, 0.55, …, 1.50`;
- totals equal the sum of per-100-g snapshots and rounded actual grams;
- exact energy/protein `10%` boundaries and all strict macro/fiber/sugar limits;
- daily `12` foods/`5` core groups and weekly `25` foods;
- cumulative inventory across days;
- allergen subset × candidate permutation property coverage;
- avoid food, missing/mismatched snapshot, unreviewed source, unsupported target, and incomplete seven-day target input;
- stable tie-breaking and repeated-call deep equality;
- a case where greedy day-one selection fails inventory but deterministic depth-first backtracking finds the full week;
- `fixedDays` consume inventory and remain byte-equivalent while only requested dates regenerate.

```ts
expect(infeasible).toEqual({
  kind: 'infeasible',
  code: 'nutrition_constraints_infeasible',
  conflicts: expect.arrayContaining([
    expect.objectContaining({ businessDate: '2026-08-20', code: 'inventory_insufficient' })
  ])
});
```

- [ ] **Step 2: Run the generator test and verify RED**

```powershell
pnpm.cmd exec vitest run packages/calculation/src/generate-weekly-meal-plan.test.ts packages/calculation/src/evaluate-recipe-candidate.test.ts
```

Expected: FAIL because policies and generator do not exist.

- [ ] **Step 3: Implement versioned policy objects**

```ts
export const WEEKLY_MEAL_SERVING_MULTIPLIERS = Object.freeze(
  Array.from({ length: 21 }, (_, index) => (50 + index * 5) / 100)
);

export const MEAL_PLAN_VALIDATION_V1 = Object.freeze({
  policyVersion: 'meal-plan-validation-v1' as const,
  sourceIds: ['CN-DRI-MACRO-2017'] as const,
  energyRelativeTolerance: 0.1,
  proteinRelativeTolerance: 0.1,
  effectiveDate: '2026-08-10',
  reviewedAt: '2026-08-10'
});

export const FOOD_DIVERSITY_POLICY_V1 = Object.freeze({
  policyVersion: 'food-diversity-policy-v1' as const,
  sourceIds: ['CNS-DIETARY-GUIDELINES-2022'] as const,
  minimumDistinctFoodsPerDay: 12,
  minimumCoreFoodGroupsPerDay: 5,
  minimumDistinctFoodsPerWeek: 25,
  effectiveDate: '2026-08-10',
  reviewedAt: '2026-08-10'
});
```

Define the generator contract in `generate-weekly-meal-plan.ts`:

```ts
export type WeeklyMealConflictCode =
  | 'target_nutrition_infeasible'
  | 'source_chain_incomplete'
  | 'allergen_detected'
  | 'avoided_food'
  | 'inventory_insufficient'
  | 'nutrition_out_of_range'
  | 'food_diversity_insufficient';

export interface WeeklyMealConflict {
  readonly businessDate: string;
  readonly code: WeeklyMealConflictCode;
  readonly foodId?: string | undefined;
  readonly requiredGrams?: number | undefined;
  readonly availableGrams?: number | undefined;
}

export type WeeklyMealInfeasibleResult = {
  readonly kind: 'infeasible';
  readonly code: 'nutrition_constraints_infeasible';
  readonly conflicts: readonly WeeklyMealConflict[];
};

export type WeeklyMealGenerationResult =
  | {
      readonly kind: 'generated';
      readonly policyVersion: 'weekly-meal-generation-v1';
      readonly catalogVersionId: string;
      readonly days: readonly MealPlanDay[];
    }
  | WeeklyMealInfeasibleResult;

export function generateWeeklyMealPlan(input: {
  readonly weekStartDate: string;
  readonly targets: readonly DailyNutritionTargetVersion[];
  readonly inventory: readonly InventoryVersion['items'][number][];
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
  readonly catalog: DailyMenuCatalogVersion;
  readonly menus: readonly DailyMenuTemplateVersion[];
  readonly recipes: readonly RecipeTemplateVersion[];
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly allowTestFixtures: boolean;
  readonly fixedDays: readonly MealPlanDay[];
}): WeeklyMealGenerationResult;
```

- [ ] **Step 4: Implement exact candidate expansion and nutrient recomputation**

Scale each recipe ingredient, round grams to one decimal with `roundHalfUp`, then recompute nutrients from the selected snapshot. Merge identical foods by summing grams before inventory checks. Never copy a provider total.

```ts
function scaleNutrients(per100g: NutrientValues, grams: number): NutrientValues {
  const factor = grams / 100;
  return mapNutrients(per100g, (value) => roundHalfUp(value * factor, 1));
}
```

Return date-level stable conflicts with exact codes: `target_nutrition_infeasible`, `source_chain_incomplete`, `allergen_detected`, `avoided_food`, `inventory_insufficient`, `nutrition_out_of_range`, and `food_diversity_insufficient`.

- [ ] **Step 5: Implement deterministic full-week search**

Precompute accepted nutrition/source candidates per date, sort by energy deviation, protein deviation, repeated-food count, menu ID, then multiplier. Use depth-first search over the sorted lists, decrementing a cloned inventory map and pruning candidates that exceed available grams. Return the first complete solution whose weekly food union meets policy; do not persist or return a partial prefix.

```ts
function search(dayIndex: number, remaining: ReadonlyMap<string, number>): MealPlanDay[] | null {
  if (dayIndex === candidatesByDate.length) return weeklyDiversitySatisfied(selected) ? [...selected] : null;
  for (const candidate of candidatesByDate[dayIndex] ?? []) {
    const nextRemaining = consumeIfAvailable(remaining, candidate.ingredientAmounts);
    if (nextRemaining === null) continue;
    selected.push(candidate);
    const complete = search(dayIndex + 1, nextRemaining);
    selected.pop();
    if (complete !== null) return complete;
  }
  return null;
}
```

- [ ] **Step 6: Run RED tests to GREEN and refactor**

Run the Step 2 command until all pass, then:

```powershell
pnpm.cmd exec vitest run packages/calculation/src
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all calculation tests and repository-wide type/lint gates exit `0`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add packages/calculation
git commit -m "feat: generate deterministic weekly meals"
```

---

### Task 3: Schema-v4 Aggregate, Migration, and Referential Invariants

**Files:**
- Modify: `packages/domain/src/versioned-planning.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.test.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.test.ts`

**Interfaces:**
- Consumes: Task-1 immutable meal records.
- Produces: schema-v4 `PlanningAggregateState`, `LatestPlanningVersions` including phase-4 counters, new write-operation/idempotency variants, migration from v2/v3, and semantic validation required by Tasks 4–6.

- [ ] **Step 1: Write RED aggregate/schema/migration tests**

Add a complete v4 state fixture and assertions:

```ts
expect(planningAggregateStateSchema.parse(v4State)).toEqual(v4State);
expect(await repository.read('user-a')).toMatchObject({
  inventories: [],
  mealPlans: [],
  mealPlanTargetDiffs: [],
  mealPlanDecisions: [],
  trainingCompletionEvents: [],
  recalculationJobs: [],
  activeInventoryVersionId: null,
  activeMealPlanVersionId: null
});
```

Test v3→v4 adds only empty collections/pointers without mutating the stored input. Add corruption cases for cross-user records, noncontiguous versions, dangling inventory/target references, duplicate meal dates, pending-confirmation plans as active, decisions referencing non-pending candidates, and duplicate `triggerEventId` jobs.

- [ ] **Step 2: Run persistence/contract tests and verify RED**

```powershell
pnpm.cmd exec vitest run packages/contracts/src/planning-api.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts
```

Expected: FAIL because the aggregate and stored schema lack phase-4 records.

- [ ] **Step 3: Extend domain aggregate and idempotency unions**

Add these exact collections and pointers:

```ts
readonly inventories: readonly InventoryVersion[];
readonly mealPlans: readonly MealPlanVersion[];
readonly mealPlanTargetDiffs: readonly MealPlanTargetDiff[];
readonly mealPlanDecisions: readonly MealPlanDecision[];
readonly trainingCompletionEvents: readonly TrainingCompletionEvent[];
readonly recalculationJobs: readonly RecalculationJob[];
readonly activeInventoryVersionId: string | null;
readonly activeMealPlanVersionId: string | null;
```

Extend `LatestPlanningVersions` with `inventory`, `mealPlan`, `mealPlanDecision`, and `trainingCompletion`. Add idempotency operations `saveInventory`, `generateWeeklyMealPlan`, `setMealPlanDayLock`, `updateMealPlanDay`, `recordTrainingCompletion`, `decideMealPlanCandidate`, and `retryPendingRecalculation`; each stores the immutable result version/event ID needed for replay.

- [ ] **Step 4: Implement strict stored schemas and v4 migration**

Change storage encoding to `{ schemaVersion: 4, state }`. Decode:

```ts
const phase4Empty = {
  inventories: [], mealPlans: [], mealPlanTargetDiffs: [], mealPlanDecisions: [],
  trainingCompletionEvents: [], recalculationJobs: [],
  activeInventoryVersionId: null, activeMealPlanVersionId: null
};
const candidateState = value.schemaVersion === 2
  ? { ...value.state, dailyNutritionTargets: [], ...phase4Empty }
  : value.schemaVersion === 3
    ? { ...value.state, ...phase4Empty }
    : value.state;
```

Accept only schema versions `2`, `3`, and `4`; encode only `4`.

- [ ] **Step 5: Implement semantic invariants**

Validate ownership, unique IDs, per-entity contiguous versions, seven unique ordered meal dates, exact week membership, same-chain profile/goal/training/target references, inventory/snapshot identity, candidate/diff/decision links, unique job trigger events, and active readiness. Keep validation linear by prebuilding maps and sets.

```ts
const inventories = new Map(state.inventories.map((value) => [value.id, value]));
const mealPlans = new Map(state.mealPlans.map((value) => [value.id, value]));
const nutritionTargets = new Map(state.dailyNutritionTargets.map((value) => [value.id, value]));
for (const plan of state.mealPlans) {
  const inventory = inventories.get(plan.inventoryVersionId);
  if (inventory === undefined || plan.days.length !== 7) corrupt();
  assertUnique(plan.days.map((day) => day.businessDate));
  for (const day of plan.days) {
    const target = nutritionTargets.get(day.dailyNutritionTargetVersionId);
    if (target?.trainingPlanVersionId !== plan.trainingPlanVersionId) corrupt();
  }
}
const activeMealPlan = state.activeMealPlanVersionId === null
  ? undefined
  : mealPlans.get(state.activeMealPlanVersionId);
if (state.activeMealPlanVersionId !== null && activeMealPlan?.readiness !== 'complete') corrupt();
```

- [ ] **Step 6: Run focused tests to GREEN and repository regression**

```powershell
pnpm.cmd exec vitest run packages/contracts/src/planning-api.test.ts packages/persistence/src
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all commands exit `0`; v2 and v3 migrations remain covered.

- [ ] **Step 7: Commit Task 3**

```powershell
git add packages/domain/src/versioned-planning.ts packages/contracts/src/planning-api.ts packages/contracts/src/planning-api.test.ts packages/persistence
git commit -m "feat: persist meal planning aggregate v4"
```

---

### Task 4: Versioned Inventory and Initial Weekly Meal Generation

**Files:**
- Create: `packages/application/src/meal-plan-generation.ts`
- Create: `packages/application/src/meal-plan-generation.test.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.test.ts`

**Interfaces:**
- Consumes: Task-1 providers/fixtures, Task-2 generator, Task-3 v4 repository.
- Produces: `saveInventory`, `resolveFoodName`, `generateWeeklyMealPlan`, phase-4 context fields, `ProviderUnavailableError`, `NutritionConstraintsInfeasibleError`, and public inventory/meal DTOs.

- [ ] **Step 1: Write RED application tests for inventory and generation**

Build a service with fixed `now`, `nextId`, in-memory repository, reviewed cache, recipe provider, and menu provider. Prove:

```ts
const saved = await service.saveInventory('user-a', {
  expectedVersion: 0,
  idempotencyKey: 'inventory-save-001',
  payload: { items: [{ name: '测试米饭', availableGrams: 5000 }] }
});
expect(saved).toMatchObject({ version: 1, items: [{ foodId: 'fixture-rice' }] });
```

Add tests for normalized duplicate-name merging, unresolved name rejection, source rejection, expected-version conflict, same-key replay, same-key/different-payload conflict, prerequisite/full-seven-target checks, deterministic generation, no partial write on infeasible/provider failure, and compare-and-set rejection when active inventory/target changes after provider load.

- [ ] **Step 2: Run application test and verify RED**

```powershell
pnpm.cmd exec vitest run packages/application/src/meal-plan-generation.test.ts packages/persistence/src/versioned-planning.test.ts
```

Expected: FAIL because service dependencies and commands do not exist.

- [ ] **Step 3: Implement provider snapshot loader and compare token**

Create:

```ts
export interface MealPlanningProviders {
  readonly nutrition: NutritionProvider;
  readonly recipes: RecipeTemplateProvider;
  readonly menus: DailyMenuCatalogProvider;
  readonly allowTestFixtures: boolean;
}

export interface MealGenerationCompareToken {
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly trainingPlanVersionId: string;
  readonly inventoryVersionId: string;
  readonly dailyNutritionTargetVersionIds: readonly string[];
}
```

Load catalog → menus → recipes → snapshots with deduplicated sorted IDs, freeze/clone validated data, then transact and compare every token field before appending a meal plan.

- [ ] **Step 4: Implement inventory and generation service methods**

`saveInventory` resolves all names before the transaction, merges by `foodId`, sorts items, fingerprints the normalized envelope, and appends a complete snapshot. `generateWeeklyMealPlan` requires seven feasible daily nutrition targets, calls the pure generator, and appends one `readiness: 'complete'` version with `activeMealPlanVersionId` changed in the same transaction.

```ts
async saveInventory(
  userId: string,
  envelope: WriteCommandEnvelope<{ readonly items: readonly { readonly name: string; readonly availableGrams: number }[] }>
): Promise<InventoryVersion>;

async generateWeeklyMealPlan(
  userId: string,
  envelope: WriteCommandEnvelope<{ readonly weekStartDate: string }>
): Promise<MealPlanVersion>;
```

The generation commit has one state transition:

```ts
return {
  nextState: {
    ...state,
    mealPlans: [...state.mealPlans, mealPlan],
    activeMealPlanVersionId: mealPlan.id,
    idempotencyRecords: [...state.idempotencyRecords, record]
  },
  result: mealPlan
};
```

Extend `getCurrentContext` with active inventory/meal plan, `mealPlanStale`, latest unresolved candidate/diffs, and phase-4 version counters. Compute stale from exact current training and target IDs; never mutate the active plan to store stale.

- [ ] **Step 5: Add strict API actions and public mappings**

Requests:

```ts
{ action: 'resolveFoodName', payload: { name: string } }
{ action: 'saveInventory', payload: WriteEnvelope<{ items: { name: string; availableGrams: number }[] }> }
{ action: 'generateWeeklyMealPlan', payload: WriteEnvelope<{ weekStartDate: string }> }
```

Responses use kinds `food_name_resolved`, `inventory_saved`, and `weekly_meal_plan_generated`. Public records omit `userId`; extra client fields reject. Map source/provider failures to `provider_unavailable`, deterministic infeasibility to `nutrition_constraints_infeasible`, and retain stable existing errors.

- [ ] **Step 6: Configure local and production runtimes**

Local mode constructs Task-1 fixture providers. Cloud/production mode constructs empty production providers that reject lookups with `provider_unavailable`; it must never load test fixtures. Keep provider construction in a small `createRuntimeMealPlanningProviders(mode)` helper so phase-seven CloudBase reviewed-data adapters can replace it without changing application code.

```ts
function createRuntimeMealPlanningProviders(mode: 'local' | 'cloud'): MealPlanningProviders {
  const allowTestFixtures = mode === 'local';
  return {
    nutrition: new ReviewedNutritionCache({
      mode: allowTestFixtures ? 'test' : 'production',
      snapshots: allowTestFixtures ? TEST_NUTRITION_SNAPSHOTS : []
    }),
    recipes: new StaticRecipeTemplateProvider({
      mode: allowTestFixtures ? 'test' : 'production',
      templates: allowTestFixtures ? TEST_RECIPE_TEMPLATES : []
    }),
    menus: new StaticDailyMenuCatalogProvider({
      mode: allowTestFixtures ? 'test' : 'production',
      catalog: allowTestFixtures ? TEST_DAILY_MENU_CATALOG : null,
      menus: allowTestFixtures ? TEST_DAILY_MENU_TEMPLATES : []
    }),
    allowTestFixtures
  };
}
```

- [ ] **Step 7: Run application/API tests to GREEN**

```powershell
pnpm.cmd exec vitest run packages/application/src/meal-plan-generation.test.ts packages/persistence/src/versioned-planning.test.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all commands exit `0`; handler responses contain no `userId`.

- [ ] **Step 8: Commit Task 4**

```powershell
git add packages/application packages/persistence/src/versioned-planning.test.ts packages/contracts/src/planning-api.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src
git commit -m "feat: save inventory and generate weekly meals"
```

---

### Task 5: Day Locks and Structured Manual Meal Changes

**Files:**
- Create: `packages/application/src/meal-plan-editing.ts`
- Create: `packages/application/src/meal-plan-editing.test.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`

**Interfaces:**
- Consumes: active complete meal plan, provider records, serving grid, inventory, profile hard constraints, and current business date.
- Produces: `setMealPlanDayLock`, `updateMealPlanDay`, `PastFactImmutableError`, and selectable recipe options in current context.

- [ ] **Step 1: Write RED lock and edit tests**

Prove locking creates a complete immutable successor, changes only one future day, and leaves the old plan unchanged. Prove past dates reject, idempotent replay returns the same successor, and unlock affects only later recalculation.

For manual edit:

```ts
const edited = await service.updateMealPlanDay('user-a', {
  expectedVersion: 2,
  idempotencyKey: 'meal-edit-001',
  payload: {
    businessDate: '2026-08-19',
    slot: 'dinner',
    recipeTemplateVersionId: 'recipe-version-fixture-dinner-b-v1'
  }
});
expect(edited.days.find((day) => day.businessDate === '2026-08-19')).toMatchObject({
  locked: true,
  manuallyModified: true
});
```

Add failures for unlisted recipe ID, allergen, avoid food, missing source, inventory exhaustion, nutrient range, concurrent active-plan change, and any partial state write.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm.cmd exec vitest run packages/application/src/meal-plan-editing.test.ts packages/persistence/src/versioned-planning.test.ts
```

Expected: FAIL because lock/edit operations do not exist.

- [ ] **Step 3: Implement pure replacement selection**

Given the active day, replace exactly one slot, keep all other assignments fixed, test every Task-2 multiplier for the selected recipe, recompute whole-day nutrients and whole-week inventory, and select the first valid result by energy deviation, protein deviation, recipe ID, multiplier. Return structured infeasibility rather than altering other meals or relaxing constraints.

```ts
export function selectManualMealReplacement(input: {
  readonly currentPlan: MealPlanVersion;
  readonly businessDate: string;
  readonly slot: MealSlot;
  readonly replacementRecipe: RecipeTemplateVersion;
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly inventory: InventoryVersion;
  readonly target: DailyNutritionTargetVersion;
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
}): MealPlanDay | WeeklyMealInfeasibleResult;
```

- [ ] **Step 4: Implement transactional successors and API actions**

Requests:

```ts
{ action: 'setMealPlanDayLock', payload: WriteEnvelope<{ businessDate: string; locked: boolean }> }
{ action: 'updateMealPlanDay', payload: WriteEnvelope<{
  businessDate: string;
  slot: MealSlot;
  recipeTemplateVersionId: string;
}> }
```

Both operations recheck active plan/inventory/target IDs inside the transaction. A successful manual edit sets `locked` and `manuallyModified` to `true`; the public response kind is `meal_plan_updated`. `getCurrentContext` exposes server-provided recipe choices containing ID and Chinese dish name so users never type IDs.

- [ ] **Step 5: Run API/application tests to GREEN**

```powershell
pnpm.cmd exec vitest run packages/application/src/meal-plan-editing.test.ts packages/persistence/src/versioned-planning.test.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all commands exit `0` and old plan versions remain deep-equal to pre-command copies.

- [ ] **Step 6: Commit Task 5**

```powershell
git add packages/application packages/contracts/src/planning-api.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.ts cloudfunctions/planning-api/src/handler.test.ts packages/persistence/src/versioned-planning.test.ts
git commit -m "feat: protect and edit meal plan days"
```

---

### Task 6: Training-Change Consumption, Completion Facts, and Candidate Decisions

**Files:**
- Create: `packages/application/src/meal-plan-recalculation.ts`
- Create: `packages/application/src/meal-plan-recalculation.test.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/application/src/versioned-planning.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.test.ts`

**Interfaces:**
- Consumes: pending `TrainingPlanChanged`, active meal plan, Task-2 fixed-day generation, Task-4 providers, Task-5 protection flags.
- Produces: `processTrainingPlanChanged`, `recordTrainingCompletion`, `decideMealPlanCandidate`, `retryPendingRecalculation`, stale/pending context, exact diffs, and completed/retryable jobs.

- [ ] **Step 1: Write RED pure recalculation analysis tests**

Test that moving a session marks old/new future dates, cancellation marks the original date, duration change marks one date, and past dates never enter affected output. Given a meal plan, prove unaffected days remain deep-equal, unlocked affected days become generation inputs, and locked/manual days produce:

```ts
{
  businessDate: '2026-08-20',
  previousNutritionTargetVersionId: 'nutrition-old-20',
  proposedNutritionTargetVersionId: 'nutrition-new-20',
  reason: 'locked_or_manually_modified'
}
```

- [ ] **Step 2: Write RED service tests for event/job lifecycle**

Implement the following lifecycle cases as separate tests; the locked case must assert all three IDs and the unchanged active pointer:

- `saveTrainingPlan` immediately attempts its pending event and activates a complete unlocked successor;
- locked/manual dates create a `pending_confirmation` candidate and leave the old active pointer unchanged/stale;
- `keep_existing` records an immutable decision, completes the job, and keeps stale active plan;
- `overwrite_locked` generates a complete successor and activates it only after success;
- duplicate event processing and duplicate decisions are idempotent;
- provider/infeasible failure keeps old activity and a retryable job;
- retry succeeds without duplicate targets/meal versions;
- target/provider version changes during load return `version_conflict` with no partial write.

```ts
expect(afterLockedChange.activeMealPlanVersionId).toBe(previousActive.id);
expect(pendingCandidate.readiness).toBe('pending_confirmation');
expect(pendingDiff.candidateMealPlanVersionId).toBe(pendingCandidate.id);
```

- [ ] **Step 3: Write RED completion-fact tests**

```ts
const recorded = await service.recordTrainingCompletion('user-a', {
  expectedVersion: 0,
  idempotencyKey: 'completion-001',
  payload: { businessDate: '2026-08-19', completedDurationMinutes: 30 }
});
expect(recorded.event.completedDurationMinutes).toBe(30);
expect(recorded.dailyEnergyTargets).toHaveLength(1);
expect(recorded.dailyEnergyTargets[0]?.trainingCompletionEventId).toBe(recorded.event.id);
```

Add tests for `0` minutes, lower planned duration, future rejection, unplanned-date rejection, past fact-only recording, fact persistence when generation fails, exact target references, lock diff behavior, idempotent replay, and no past meal rewrite.

- [ ] **Step 4: Run application tests and verify RED**

```powershell
pnpm.cmd exec vitest run packages/application/src/meal-plan-recalculation.test.ts packages/application/src/versioned-planning.test.ts packages/persistence/src/versioned-planning.test.ts
```

Expected: FAIL because event consumption, completion, jobs, and decisions are absent.

- [ ] **Step 5: Implement two-transaction fact/job workflow**

For training saves and completions, the first transaction appends immutable facts/targets and a unique pending job. The second stage loads provider data, then transacts with a compare token. Provider failure updates only the operational job to `failed_retryable`; it never removes the fact or replaces the active meal plan.

Treat a `TrainingPlanChanged` event as delivered when a unique `RecalculationJob.triggerEventId` exists; do not mutate the event's historical `status: 'pending'` field. Duplicate consumers first look up the job by event ID and replay its state.

```ts
const recorded = await appendFactAndPendingJob(userId, envelope);
try {
  return await processRecalculationJob(userId, recorded.recalculationJob.id);
} catch (error: unknown) {
  if (error instanceof ProviderUnavailableError || error instanceof NutritionConstraintsInfeasibleError) {
    return markJobRetryableAndReturnRecordedFact(userId, recorded, error.code);
  }
  throw error;
}
```

Extend daily targets with optional `trainingCompletionEventId`; invariants require both energy and nutrition targets to reference the same completion event and plan/date.

- [ ] **Step 6: Implement candidate and decision activation**

Use Task-2 `fixedDays` for unaffected days. Pending candidates include regenerated unlocked days and preserved protected days plus exact diffs; they never become active. `overwrite_locked` regenerates all affected protected dates. `keep_existing` stores the decision without claiming the stale plan matches new targets.

```ts
if (command.decision === 'keep_existing') {
  return appendDecisionAndCompleteJob({ activatedMealPlanVersionId: null });
}
const generated = await regenerateCandidate({ overwriteProtectedDates: true });
if (generated.kind === 'infeasible') throw new NutritionConstraintsInfeasibleError(generated.conflicts);
return appendDecisionAndActivate({ activatedMealPlanVersionId: generated.plan.id });
```

Requests:

```ts
{ action: 'recordTrainingCompletion', payload: WriteEnvelope<{
  businessDate: string;
  completedDurationMinutes: number;
}> }
{ action: 'decideMealPlanCandidate', payload: WriteEnvelope<{
  candidateMealPlanVersionId: string;
  decision: 'keep_existing' | 'overwrite_locked';
}> }
{ action: 'retryPendingRecalculation', payload: WriteEnvelope<{ recalculationJobId: string }> }
```

- [ ] **Step 7: Implement API mapping and independent completion response**

Return kind `training_completion_recorded` with the event, target versions, job, optional candidate, and diffs. If immediate meal processing fails, return success for the recorded fact plus `recalculationStatus: 'failed_retryable'`; do not map that outcome to a failed request. Map future/past-edit errors to `past_fact_immutable`, invalid candidate state to `candidate_not_pending`, and provider failures during explicit retry/decision to `provider_unavailable`.

- [ ] **Step 8: Run focused and full application/API tests to GREEN**

```powershell
pnpm.cmd exec vitest run packages/application/src packages/persistence/src/versioned-planning.test.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all commands exit `0`; move/cancel/duration/completion tests assert affected records exist before checking references, avoiding vacuous `every()` assertions.

- [ ] **Step 9: Commit Task 6**

```powershell
git add packages/application packages/domain/src/versioned-planning.ts packages/contracts/src/planning-api.ts packages/contracts/src/planning-api.test.ts packages/persistence/src/versioned-planning.test.ts cloudfunctions/planning-api/src
git commit -m "feat: recalculate meals from training facts"
```

---

### Task 7: Native Weekly Meal and Execution Page

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `scripts/build-miniprogram.mjs`
- Modify: `miniprogram/pages/planning-setup/index.wxml`
- Modify: `miniprogram/pages/planning-setup/index.ts`
- Create: `miniprogram/pages/meal-execution/index.json`
- Create: `miniprogram/pages/meal-execution/index.wxml`
- Create: `miniprogram/pages/meal-execution/index.wxss`
- Create: `miniprogram/pages/meal-execution/index.ts`
- Create: `miniprogram/pages/meal-execution/form.ts`
- Create: `miniprogram/pages/meal-execution/form.test.ts`
- Create: `miniprogram/pages/meal-execution/view-model.ts`
- Create: `miniprogram/pages/meal-execution/view-model.test.ts`
- Modify: `miniprogram/services/planning-api.test.ts`

**Interfaces:**
- Consumes: strict public API responses from Tasks 4–6 and existing `planningApiClient`.
- Produces: buildable native page with multi-row inventory resolution, seven-day rendering, locks, structured edits, stale diffs/decisions, retry, and independent completion recording.

- [ ] **Step 1: Write RED form tests**

Test parsing without internal IDs:

```ts
expect(buildInventoryRequest({
  rows: [{ name: '测试米饭', availableGrams: '5000' }],
  expectedVersion: 0,
  idempotencyKey: 'inventory-ui-001'
})).toEqual({
  action: 'saveInventory',
  payload: {
    expectedVersion: 0,
    idempotencyKey: 'inventory-ui-001',
    payload: { items: [{ name: '测试米饭', availableGrams: 5000 }] }
  }
});
```

Add tests for blank/duplicate names, nonnumeric/zero grams, completion minutes `0–300`, future/invalid business dates, lock request, server-selected recipe option, candidate decision, and retry request.

- [ ] **Step 2: Write RED view-model/controller tests**

Prove current context becomes seven sorted day cards with Chinese meal slots, grams, estimated nutrient labels, lock state, and stale banner. Prove pending diffs show both choices, provider/infeasible conflicts render actionable messages, fact success remains visible when recalculation is retryable, and no visible input asks for an internal ID.

- [ ] **Step 3: Run page tests and verify RED**

```powershell
pnpm.cmd exec vitest run miniprogram/pages/meal-execution miniprogram/services/planning-api.test.ts
```

Expected: FAIL because the page modules do not exist.

- [ ] **Step 4: Implement pure form and view-model modules**

Keep all numeric/date parsing and API request construction outside the page controller. Map meal slots exactly:

```ts
export const MEAL_SLOT_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐'
} as const;
```

View models contain display strings only; API records remain unchanged for command construction.

- [ ] **Step 5: Implement controller and WXML interactions**

On load call `getCurrentContext`. Resolve each inventory row before enabling save; after save allow generation. Render all seven days, lock switches, recipe picker, pending choices, completion form, and retry button. Use separate `savingFact` and `recalculatingMeal` states so meal failure never masks successful completion recording.

```ts
async onRecordCompletion(): Promise<void> {
  this.setData({ savingFact: true, factMessage: '', recalculatingMeal: false });
  const response = await planningApiClient.call(buildCompletionRequest(this.data));
  if (response.success && response.data.kind === 'training_completion_recorded') {
    this.setData({
      savingFact: false,
      factMessage: '训练完成情况已保存。',
      recalculatingMeal: response.data.recalculationStatus === 'pending'
    });
    await this.refreshContext();
    return;
  }
  this.setData({ savingFact: false, factMessage: response.success ? '返回结果不匹配。' : response.error.message });
}
```

- [ ] **Step 6: Register page and build assets**

Add `pages/meal-execution/index` to `app.json`, esbuild entry points, and copied assets. Add a navigation button from planning setup using `wx.navigateTo({ url: '/pages/meal-execution/index' })`.

- [ ] **Step 7: Run page, type, and build verification**

```powershell
pnpm.cmd exec vitest run miniprogram/pages/meal-execution miniprogram/services/planning-api.test.ts
pnpm.cmd typecheck
pnpm.cmd build:miniprogram
pnpm.cmd lint
```

Expected: all commands exit `0`; `.build/miniprogram/pages/meal-execution/` contains JS, JSON, WXML, and WXSS.

- [ ] **Step 8: Commit Task 7**

```powershell
git add miniprogram scripts/build-miniprogram.mjs
git commit -m "feat: add weekly meal execution page"
```

---

### Task 8: End-to-End Acceptance, Documentation, and Phase Completion

**Files:**
- Create: `tests/e2e/weekly-meal-loop.test.ts`
- Modify: `tests/smoke/planning-api.smoke.test.ts`
- Modify: `README.md`
- Modify: `DEVELOPMENT_PROGRESS.md`

**Interfaces:**
- Consumes: all Tasks 1–7 behavior.
- Produces: requirement-by-requirement evidence, process-level API smoke coverage, accurate documentation, and completed phase-4 progress state.

- [ ] **Step 1: Write RED end-to-end acceptance test**

The test must execute this exact flow through the public handler with trusted `user-a` identity:

1. Complete profile/goal/full-future-week setup.
2. Resolve ordinary fixture food names and save sufficient 28-food inventory.
3. Generate seven days and independently recompute every displayed total from snapshot per-100-g values and stored grams.
4. Lock one day and manually modify another; prove both are protected.
5. Move a future session; prove exact old/new dates, unchanged unrelated days, stale active plan, candidate, and diffs.
6. Choose `keep_existing`; prove acknowledgement and preserved stale activity.
7. Make a later duration change and choose `overwrite_locked`; prove complete atomic successor activation.
8. Record fewer completion minutes today; prove only today receives completion-linked target versions.
9. Replay event/commands and prove version counts do not grow.
10. Trigger allergen, insufficient inventory, missing source, provider failure, and infeasible target cases; prove no partial active version.

Core assertions include:

```ts
expect(new Set(plan.days.map((day) => day.businessDate)).size).toBe(7);
expect(recalculated.days.filter((day) => affectedDates.includes(day.businessDate))).toHaveLength(affectedDates.length);
expect(afterReplay.latestVersions).toEqual(beforeReplay.latestVersions);
expect(pastSnapshot).toEqual(structuredClone(pastSnapshotBeforeChanges));
```

- [ ] **Step 2: Run E2E test as an acceptance gate**

```powershell
pnpm.cmd exec vitest run tests/e2e/weekly-meal-loop.test.ts
```

Expected: PASS because Tasks 1–7 supplied RED-first behavior tests. If it fails, record the exact failing assertion before changing production code.

- [ ] **Step 3: Repeat the E2E gate to prove deterministic replay**

Run the same acceptance file again without changing fixtures or state. The test creates isolated dependencies per case, so both runs must produce identical version counts, target IDs under fixed `nextId`, and meal content.

```powershell
pnpm.cmd exec vitest run tests/e2e/weekly-meal-loop.test.ts
```

Expected: PASS again with the same assertion count and no skipped case. Any failure is a defect and must be diagnosed with `superpowers:systematic-debugging` before this task continues.

- [ ] **Step 4: Extend process-level smoke**

Keep existing health/preview cases and add authenticated local runtime setup → inventory → generation → context verification. Assert the real function process returns seven days and no response contains a `userId`. The smoke uses only `FITNESS_RUNTIME_MODE=local` fixture data.

- [ ] **Step 5: Update README to actual behavior**

Document manual inventory, deterministic seven-day generation, source/fixture boundary, day locks/manual edits, stale/pending choices, completion facts, retry behavior, API actions, and the page run path. State explicitly that production reviewed meal data, licensing, CloudBase deployment, WeChat IDE/device rendering, image recognition, and LLM dialogue are not completed by phase 4.

- [ ] **Step 6: Run the full fresh verification gate**

Run each command separately and record exact counts/results:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
```

Expected: every command exits `0`; test output has zero failed/skipped phase-4 acceptance cases; build produces deployable planning-api and miniprogram artifacts.

- [ ] **Step 7: Audit requirements and update dynamic progress**

Re-read `AGENTS.md`, the approved design, and all five phase-4 acceptance lines. For each line, point to concrete tests and implementation. Only then change overview/phase status to `已完成`, check all five boxes, record commit IDs, six fresh command results and test counts, list WeChat IDE/device rendering as unverified if not observed, retain production data/DRI authorization gates, and set phase five as next.

- [ ] **Step 8: Inspect final diff and secrets/sensitive data**

```powershell
git status --short
git diff --check HEAD
git diff --stat 705b155 -- . ':(exclude).pnpm-store'
git diff 705b155 -- . ':(exclude).pnpm-store'
rg -n -i "api[_-]?key|secret|token|BEGIN (RSA|OPENSSH)|base64|signed.?url" packages cloudfunctions miniprogram data tests README.md DEVELOPMENT_PROGRESS.md
```

Review every match; fixture IDs are allowed, real credentials, user photos, personal data, and sensitive request bodies are not.

- [ ] **Step 9: Commit Task 8**

```powershell
git add tests README.md DEVELOPMENT_PROGRESS.md
git commit -m "test: complete weekly meal loop acceptance"
```

- [ ] **Step 10: Re-run final verification after the documentation commit**

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
git status --short --branch
```

Expected: six verification commands exit `0`; Git status shows only the pre-existing untracked `.pnpm-store/`; `DEVELOPMENT_PROGRESS.md` evidence matches the fresh outputs exactly.

---

## Completion Gate

Phase 4 is complete only when all eight tasks are committed on `feat/v1.0`, every design/AGENTS acceptance requirement has direct current-state evidence, all six final commands pass after the last commit, and the only remaining workspace item is the preserved `.pnpm-store/`. Do not claim CloudBase production data availability, licensing, WeChat visual/device validation, phase-five image support, phase-six Agent support, or public-release readiness without their external evidence.
