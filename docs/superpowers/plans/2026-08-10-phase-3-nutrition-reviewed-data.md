# Phase 3 Nutrition and Reviewed Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete phase 3 by producing traceable daily nutrition targets, deterministic constraint results, versioned reviewed exercise/MET data, runtime-validated nutrition snapshots and recipe templates, and an offline-only `NutritionProvider` path.

**Architecture:** Keep calculations pure in `@fitness/calculation`, shared records and provider ports in `@fitness/domain`, runtime schemas in `@fitness/contracts`, static/cache adapters in a new `@fitness/providers` package, and versioned qualitative data under `data/`. Daily nutrition targets are immutable records linked to the exact daily energy target; CloudBase aggregate schema v2 documents migrate structurally to v3 by adding an empty nutrition-target history, without rewriting historical energy facts.

**Tech Stack:** TypeScript 5.9 strict mode, Zod 4, Vitest 3, pnpm 9 workspaces, CloudBase Node.js cloud functions, WeChat native miniprogram.

## Global Constraints

- Work only on `feat/v1.0`; do not create a branch or worktree and do not merge `phase1-local`.
- Do not install a dependency or call a live/paid nutrition API.
- Numeric policy remains `nutrition-policy-v1`; its first active numeric implementation uses `CN-DRI-MACRO-2017`, `PROTEIN-MORTON-2018`, and `ISSN-PROTEIN-2017`. `CN-DRI-2023` remains a production-review blocker and is not represented as a reviewed numeric source.
- Only deterministic TypeScript produces calories, grams, percentages, and aggregate nutrition values.
- Allergens are hard constraints. Source-chain, inventory, food-state, and feasibility failures return structured errors rather than substituted values.
- Exercise records stay qualitative and contain no exercise-level MET. Only reviewed session codes map to MET.
- Test nutrition values use `qualityStatus: "test_fixture"`; production mode rejects them.
- Existing untracked `.pnpm-store/` is user-owned and must not be changed or staged.

---

## File Map

- `packages/domain/src/nutrition-target.ts`: target input, policy metadata, feasible/infeasible result types.
- `packages/domain/src/food-nutrition.ts`: snapshots, recipes, provider ports, candidate constraints and conflicts.
- `packages/calculation/src/nutrition-policy.ts`: all nutrition constants and provenance.
- `packages/calculation/src/calculate-nutrition-targets.ts`: macro constraint intersection.
- `packages/calculation/src/evaluate-recipe-candidate.ts`: allergen/avoid/inventory/source checks and per-100-g recomputation.
- `packages/contracts/src/nutrition.ts`: shared Zod schemas for nutrition data and results.
- `packages/providers/src/reviewed-nutrition-cache.ts`: offline runtime-validated `NutritionProvider`.
- `packages/providers/src/static-recipe-template-provider.ts`: offline runtime-validated recipe template provider.
- `data/nutrition-fixtures/src/index.ts`: explicitly non-production snapshots and recipes for deterministic tests.
- `data/exercises/src/exercise-catalog.ts`: exact versioned 80-exercise qualitative catalog.
- `data/met-sessions/src/reviewed-met-sessions.ts`: reviewed session-level MET records.
- `packages/domain/src/versioned-planning.ts`: immutable `DailyNutritionTargetVersion` linked to energy target.
- `packages/application/src/versioned-planning.ts`: create and replay nutrition targets atomically with affected energy targets.
- `packages/persistence/src/*.ts`: schema v2-to-v3 structural migration and referential invariants.
- `packages/contracts/src/planning-api.ts`: API schemas for nutrition targets; request DTOs remain MET-free.
- `cloudfunctions/planning-api/src/handler.ts`: public nutrition-target serialization.
- `miniprogram/pages/planning-setup/target-display.ts`: deterministic user-facing energy/macro text.
- `DEVELOPMENT_PROGRESS.md` and `README.md`: phase status, verification evidence, migration and current behavior.

---

### Task 1: Start Phase 3 and Implement Nutrition Target Policy

**Files:**
- Modify: `DEVELOPMENT_PROGRESS.md`
- Create: `packages/domain/src/nutrition-target.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/calculation/src/nutrition-policy.ts`
- Create: `packages/calculation/src/calculate-nutrition-targets.test.ts`
- Create: `packages/calculation/src/calculate-nutrition-targets.ts`
- Modify: `packages/calculation/src/policy.ts`
- Modify: `packages/calculation/src/index.ts`

**Interfaces:**
- Consumes: `FitnessGoal`, `SexCode`, and `roundHalfUp`.
- Produces: `calculateNutritionTargets(input: NutritionTargetInput): NutritionTargetResult`, `NUTRITION_POLICY_V1`, `TrainingKind`, and structured `NutritionConstraintConflict` objects.

- [ ] **Step 1: Mark phase 3 as in progress**

Change the overview and phase heading status from `未开始` to `进行中`; do not check acceptance boxes yet.

- [ ] **Step 2: Write failing policy/calculation tests**

Cover each branch independently:

```ts
it.each([
  [{ sexCode: 0, trainingKind: 'none', goal: 'maintain' }, 65],
  [{ sexCode: 1, trainingKind: 'none', goal: 'maintain' }, 55],
  [{ sexCode: 0, trainingKind: 'general_or_endurance', goal: 'maintain' }, 98],
  [{ sexCode: 0, trainingKind: 'regular_resistance', goal: 'maintain' }, 112],
  [{ sexCode: 0, trainingKind: 'none', goal: 'muscle_gain' }, 112]
])('selects the protein branch for %o', (branch, expectedProteinG) => {
  const result = calculateNutritionTargets({
    targetEnergyKcal: 2_000,
    weightKg: 70,
    ...branch
  });
  expect(result.kind).toBe('feasible');
  if (result.kind === 'feasible') expect(result.proteinG).toBe(expectedProteinG);
});
```

Also assert fat `20%–30%E`, carbohydrate `50%–65%E` and `>=120 g`, fiber `25–30 g`, saturated fat `<10%E`, added sugar `<10%E`, half-up rounding, the `2.0 g/kg` automatic ceiling, and a low-energy empty intersection returning:

```ts
{
  kind: 'infeasible',
  code: 'nutrition_constraints_infeasible',
  conflicts: expect.arrayContaining([
    expect.objectContaining({ code: 'macro_energy_intersection_empty' })
  ])
}
```

- [ ] **Step 3: Run the new test and verify RED**

Run: `pnpm.cmd exec vitest run packages/calculation/src/calculate-nutrition-targets.test.ts`

Expected: FAIL because `calculateNutritionTargets` and the active policy module do not exist.

- [ ] **Step 4: Add domain result types and the centralized policy**

Use these stable shapes:

```ts
export type TrainingKind = 'none' | 'general_or_endurance' | 'regular_resistance';

export interface NutritionTargetInput {
  readonly targetEnergyKcal: number;
  readonly weightKg: number;
  readonly sexCode: SexCode;
  readonly goal: FitnessGoal;
  readonly trainingKind: TrainingKind;
}

export type NutritionConstraintConflict =
  | { readonly code: 'protein_automatic_max_exceeded'; readonly proteinG: number; readonly maximumG: number }
  | { readonly code: 'carbohydrate_minimum_exceeds_share_maximum'; readonly minimumG: 120; readonly maximumByEnergyG: number }
  | { readonly code: 'macro_energy_intersection_empty'; readonly minimumCarbohydrateKcal: number; readonly maximumCarbohydrateKcal: number };
```

`NUTRITION_POLICY_V1` contains `65/55 g`, `1.4/1.6/2.0 g/kg`, fat `20/25/30%E`, carbohydrate `50/65%E` plus `120 g`, fiber `25/30 g`, the two exclusive `10%E` limits, `4/4/9 kcal/g`, source IDs, applicable ranges, effective date, reviewed date, and explicit gram/percentage rounding rules. Remove the metadata-only duplicate from `policy.ts`.

- [ ] **Step 5: Implement the minimum interval-intersection calculator**

Select protein first, compute its energy, intersect the carbohydrate energy range with the remaining energy after fat's allowed range, choose the point nearest the 25%E fat midpoint, and only then round output grams. Convert exclusive percentage ceilings to a one-decimal exclusive gram bound with `(Math.ceil(value * 10) - 1) / 10`.

- [ ] **Step 6: Run RED-to-GREEN verification**

Run: `pnpm.cmd exec vitest run packages/calculation/src/calculate-nutrition-targets.test.ts`

Expected: PASS with every protein and feasibility branch covered.

- [ ] **Step 7: Commit the task**

```powershell
git add DEVELOPMENT_PROGRESS.md packages/domain/src/nutrition-target.ts packages/domain/src/index.ts packages/calculation/src/nutrition-policy.ts packages/calculation/src/calculate-nutrition-targets.test.ts packages/calculation/src/calculate-nutrition-targets.ts packages/calculation/src/policy.ts packages/calculation/src/index.ts
git commit -m "feat: calculate traceable nutrition targets"
```

### Task 2: Add Nutrition Snapshots, Recipe Templates, and Hard-Constraint Evaluation

**Files:**
- Create: `packages/domain/src/food-nutrition.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/contracts/src/nutrition.test.ts`
- Create: `packages/contracts/src/nutrition.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/calculation/src/evaluate-recipe-candidate.test.ts`
- Create: `packages/calculation/src/evaluate-recipe-candidate.ts`
- Modify: `packages/calculation/src/index.ts`

**Interfaces:**
- Consumes: normalized `NutritionDataSnapshot` and `RecipeTemplateVersion` records.
- Produces: `NutritionProvider`, `RecipeTemplateProvider`, `evaluateRecipeCandidate(input): RecipeCandidateResult`, and strict runtime schemas.

- [ ] **Step 1: Write failing contract and candidate tests**

Schemas must reject unknown keys, negative nutrients, missing `sourceRecordId`, unsupported original units, invalid food state, missing version/review timestamps, duplicate template ingredient food IDs, and zero grams. Candidate tests must prove:

```ts
expect(evaluateRecipeCandidate({
  template,
  snapshots,
  inventory: [{ foodId: 'fixture-soy', availableGrams: 200 }],
  allergens: ['大豆'],
  avoidFoodIds: [],
  minimumDistinctFoodGroups: 1,
  allowTestFixtures: true
})).toMatchObject({
  kind: 'infeasible',
  code: 'nutrition_constraints_infeasible',
  conflicts: [{ code: 'allergen_detected', foodId: 'fixture-soy', allergen: '大豆' }]
});
```

Loop over every allergen declared by every snapshot and assert that adding that allergen always rejects the candidate. Separately test avoid-food, insufficient inventory, missing/mismatched snapshot identity, non-reviewed source in production mode, insufficient food-group diversity, and exact per-100-g recomputation with half-up one-decimal totals.

- [ ] **Step 2: Run both files and verify RED**

Run: `pnpm.cmd exec vitest run packages/contracts/src/nutrition.test.ts packages/calculation/src/evaluate-recipe-candidate.test.ts`

Expected: FAIL because schemas, records, ports, and evaluator do not exist.

- [ ] **Step 3: Implement strict domain records**

Use immutable version identities and exact source links:

```ts
export interface NutritionDataSnapshot {
  readonly id: string;
  readonly foodId: string;
  readonly canonicalNameZh: string;
  readonly foodGroupId: FoodGroupId;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly provider: string;
  readonly originalUnit: 'per_100_g_edible_portion';
  readonly foodState: 'raw' | 'cooked' | 'dry';
  readonly datasetVersion: string;
  readonly snapshotVersion: number;
  readonly reviewedAt: string;
  readonly qualityStatus: 'reviewed' | 'test_fixture';
  readonly allergens: readonly string[];
  readonly nutrientsPer100g: NutrientValues;
}

export interface NutritionProvider {
  getSnapshot(snapshotId: string): Promise<NutritionDataSnapshot>;
}
```

`RecipeTemplateVersion` contains a stable template ID, immutable version ID and number, source/dataset/review metadata, quality status, and ingredients pinned to both `foodId` and `nutritionSnapshotId` with grams.

- [ ] **Step 4: Implement Zod schemas and deterministic candidate evaluation**

The evaluator must never query a provider. It receives already-loaded snapshots, canonicalizes allergen terms, evaluates all hard conflicts, and only if no conflict exists recomputes all seven nutrient totals using `nutrientsPer100g * grams / 100`. It returns the ordered snapshot IDs used and distinct food groups for traceability.

- [ ] **Step 5: Run candidate and contract tests GREEN**

Run: `pnpm.cmd exec vitest run packages/contracts/src/nutrition.test.ts packages/calculation/src/evaluate-recipe-candidate.test.ts`

Expected: PASS, including the exhaustive allergen loop.

- [ ] **Step 6: Commit the task**

```powershell
git add packages/domain/src/food-nutrition.ts packages/domain/src/index.ts packages/contracts/src/nutrition.test.ts packages/contracts/src/nutrition.ts packages/contracts/src/index.ts packages/calculation/src/evaluate-recipe-candidate.test.ts packages/calculation/src/evaluate-recipe-candidate.ts packages/calculation/src/index.ts
git commit -m "feat: validate constrained recipe candidates"
```

### Task 3: Implement Offline Providers and Explicit Test Fixtures

**Files:**
- Create: `packages/providers/package.json`
- Create: `packages/providers/tsconfig.json`
- Create: `packages/providers/src/reviewed-nutrition-cache.test.ts`
- Create: `packages/providers/src/reviewed-nutrition-cache.ts`
- Create: `packages/providers/src/static-recipe-template-provider.test.ts`
- Create: `packages/providers/src/static-recipe-template-provider.ts`
- Create: `packages/providers/src/index.ts`
- Create: `data/nutrition-fixtures/package.json`
- Create: `data/nutrition-fixtures/tsconfig.json`
- Create: `data/nutrition-fixtures/src/index.test.ts`
- Create: `data/nutrition-fixtures/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: unknown values at adapter boundaries and Zod schemas from `@fitness/contracts`.
- Produces: runtime-validated offline providers and `TEST_NUTRITION_SNAPSHOTS` / `TEST_RECIPE_TEMPLATES`.

- [ ] **Step 1: Write failing provider and fixture tests**

Assert invalid unknown data fails construction, duplicate snapshot/template IDs fail construction, values are cloned on return, missing IDs produce typed unavailable errors, test mode accepts `test_fixture`, production mode rejects it, and neither adapter exposes URL/credential/request methods. Fixture tests assert every recipe ingredient resolves to exactly one matching snapshot and every record carries source, original unit, state, version, and review fields.

- [ ] **Step 2: Verify RED**

Run: `pnpm.cmd exec vitest run packages/providers/src data/nutrition-fixtures/src`

Expected: FAIL because the workspace packages do not exist.

- [ ] **Step 3: Implement the providers without network behavior**

The cache constructor parses every unknown value with `nutritionDataSnapshotSchema`, checks unique immutable IDs, and stores a readonly map. `getSnapshot` rejects absent records and rejects `qualityStatus !== 'reviewed'` in production mode. The recipe provider applies the same rules with `recipeTemplateVersionSchema`.

- [ ] **Step 4: Add clearly labeled non-production fixtures**

Create at least three snapshots spanning three food groups and one recipe template. Use names prefixed with `测试`, source/provider `FITNESS-TEST-FIXTURE-V1`, deterministic values, and `qualityStatus: 'test_fixture'`; no fixture may be exported as reviewed production data.

- [ ] **Step 5: Verify GREEN and workspace type safety**

Run: `pnpm.cmd exec vitest run packages/providers/src data/nutrition-fixtures/src`

Run: `pnpm.cmd --filter @fitness/providers typecheck`

Run: `pnpm.cmd --filter @fitness/nutrition-fixtures typecheck`

Expected: all pass without network access.

- [ ] **Step 6: Commit the task**

```powershell
git add packages/providers data/nutrition-fixtures pnpm-lock.yaml
git commit -m "feat: add offline reviewed nutrition ports"
```

### Task 4: Add the Versioned Exercise Catalog and Harden Session MET Boundaries

**Files:**
- Create: `data/exercises/package.json`
- Create: `data/exercises/tsconfig.json`
- Create: `data/exercises/src/exercise-catalog.test.ts`
- Create: `data/exercises/src/exercise-catalog.ts`
- Create: `data/exercises/src/index.ts`
- Modify: `data/met-sessions/src/reviewed-met-sessions.test.ts`
- Modify: `data/met-sessions/src/reviewed-met-sessions.ts`
- Modify: `packages/domain/src/daily-energy.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/calculation/src/calculate-daily-energy.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the repository-auditable 80-item identity set in `phase1-local:data/exercises/src/exercise-catalog.ts` and official 2024 Adult Compendium session rows.
- Produces: `EXERCISE_CATALOG_V1`, `findExerciseById`, `isReviewedExerciseId`, and reviewed session codes `02050`, `02052`, `02054` with `trainingKind: 'regular_resistance'`.

- [ ] **Step 1: Write failing catalog/MET/client-boundary tests**

Assert the exact 80 stable IDs and Chinese names, unique IDs, required qualitative fields, at least two instruction steps, no `met` or `sessionCode` key in any exercise, and no images/media. Assert session records preserve code, MET, original English description, unit, category, source, dataset version, review time, and training kind. Explicitly send both preview and saved-plan payloads containing client `met` fields and expect strict contract rejection.

- [ ] **Step 2: Verify RED**

Run: `pnpm.cmd exec vitest run data/exercises/src/exercise-catalog.test.ts data/met-sessions/src/reviewed-met-sessions.test.ts packages/contracts/src/planning-api.test.ts packages/calculation/src/calculate-daily-energy.test.ts`

Expected: FAIL because the exercise package and two additional reviewed session rows are absent.

- [ ] **Step 3: Audit and introduce the qualitative catalog**

Read the historical file with:

```powershell
git show phase1-local:data/exercises/src/exercise-catalog.ts
```

Bring over only the 80 qualitative records after checking each record against the phase-3 schema and the tests. Do not cherry-pick or merge the historical commit. Keep `supportedSessionIntensities` qualitative; never assign exercise-level energy values.

- [ ] **Step 4: Expand session-level MET mappings**

Add these official rows:

```ts
{ code: '02050', met: 6, description: 'Resistance (weight lifting - free weight, nautilus or universal-type), power lifting or body building, vigorous effort' }
{ code: '02052', met: 5, description: 'Resistance (weight) training, squats, deadlift, slow or explosive effort' }
{ code: '02054', met: 3.5, description: 'Resistance (weight) training, multiple exercises, 8-15 reps at varied resistance' }
```

All three also carry `sourceId: 'MET-COMPENDIUM-2024'`, `datasetVersion: '2024.1'`, `originalUnit: 'MET'`, `activityCategory: 'conditioning_exercise'`, a reviewed timestamp, and `trainingKind: 'regular_resistance'`.

- [ ] **Step 5: Verify GREEN**

Run the four-file command from Step 2 and `pnpm.cmd --filter @fitness/exercises typecheck`.

Expected: all pass and extra client MET fields are rejected.

- [ ] **Step 6: Commit the task**

```powershell
git add data/exercises data/met-sessions packages/domain/src/daily-energy.ts packages/contracts/src/planning-api.test.ts packages/calculation/src/calculate-daily-energy.test.ts pnpm-lock.yaml
git commit -m "feat: add reviewed exercise and MET catalogs"
```

### Task 5: Persist and Expose Immutable Daily Nutrition Targets

**Files:**
- Modify: `packages/domain/src/versioned-planning.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.test.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.test.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Create: `miniprogram/pages/planning-setup/target-display.test.ts`
- Create: `miniprogram/pages/planning-setup/target-display.ts`
- Modify: `miniprogram/pages/planning-setup/index.ts`
- Modify: `miniprogram/pages/planning-setup/index.wxml`

**Interfaces:**
- Consumes: `calculateNutritionTargets`, reviewed session `trainingKind`, and existing affected-date energy targets.
- Produces: `DailyNutritionTargetVersion`, API `dailyNutritionTargets`, v3 aggregate persistence, and estimated macro display.

- [ ] **Step 1: Write failing atomic/version/migration/API/display tests**

Prove each supported affected energy target creates exactly one nutrition target with:

```ts
{
  kind: 'daily_nutrition_target_version',
  dailyEnergyTargetVersionId: energyTarget.id,
  businessDate: energyTarget.businessDate,
  bodyProfileVersionId: profile.id,
  goalVersionId: goal.id,
  trainingPlanVersionId: plan.id,
  energyPolicyVersion: 'calculation-policy-v2',
  nutritionPolicyVersion: 'nutrition-policy-v1'
}
```

Assert unsupported energy produces `nutrition: null`; idempotent replay does not append another nutrition version; same-week partial changes return only affected new targets while current context combines the latest target per date; failed transactions expose neither record type; schema v2 state decodes into schema v3 with `dailyNutritionTargets: []`; corrupt cross-user/source/date/version links are rejected; and the API/display shows protein, fat, carbohydrate, fiber, saturated-fat and added-sugar estimates without “精准” or “医学级”.

- [ ] **Step 2: Run targeted integration tests and verify RED**

Run: `pnpm.cmd exec vitest run packages/persistence/src/versioned-planning.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.test.ts miniprogram/pages/planning-setup/target-display.test.ts`

Expected: FAIL because daily nutrition versions, schema v3 migration, response fields, and the display helper do not exist.

- [ ] **Step 3: Add the immutable target record and atomic application flow**

`DailyNutritionTargetVersion` adds `dailyEnergyTargetVersionId` in addition to all required body/goal/training/policy/date references. Create it in the same pure transaction result as each affected energy target. Determine `trainingKind` from the reviewed session object, never the client DTO. Resolve idempotent replay by exact plan/energy-target IDs rather than recomputing.

- [ ] **Step 4: Add schema v3 migration and invariants**

Encode only `{ schemaVersion: 3, state }`. Decode schema v3 directly. For schema v2, create `{ ...state, dailyNutritionTargets: [] }`, validate it against the v3 schema and invariants, and return it without mutating the stored document until the next legitimate transaction. Never synthesize nutrition values for historical v2 energy targets.

- [ ] **Step 5: Update API and miniprogram presentation**

Expose nutrition target arrays alongside energy arrays in saved-plan, setup-complete, and current-context responses. Use a pure `targetDisplay` helper so page code only maps validated responses. Change page copy from “能量目标” to “能量与营养目标” and retain the estimate/non-medical disclaimer.

- [ ] **Step 6: Run targeted tests GREEN**

Run the six-file command from Step 2.

Expected: all pass, including migration and idempotency assertions.

- [ ] **Step 7: Commit the task**

```powershell
git add packages/domain/src/versioned-planning.ts packages/application/src/versioned-planning.ts packages/persistence packages/contracts/src/planning-api.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.ts cloudfunctions/planning-api/src/handler.test.ts miniprogram/pages/planning-setup
git commit -m "feat: persist daily nutrition target versions"
```

### Task 6: Phase 3 Acceptance, Documentation, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `DEVELOPMENT_PROGRESS.md`

**Interfaces:**
- Consumes: all phase-3 behavior and command output.
- Produces: reproducible acceptance evidence and an honest next-stage handoff.

- [ ] **Step 1: Run all required verification commands**

Run individually and preserve exact counts/results:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
```

Expected: all exit `0`, with no warnings from newly added code.

- [ ] **Step 2: Inspect repository scope and secrets**

Run:

```powershell
git status --short
git diff --check
git diff --stat 1855121
git diff 1855121 -- . ':(exclude).pnpm-store'
rg -n --hidden -g '!.git/**' -g '!.pnpm-store/**' -g '!node_modules/**' '(api[_-]?key|secret|token)\s*[:=]\s*["''][^"'']+["'']' .
```

Expected: only phase-3 files are changed; whitespace check passes; no real secret is found; `.pnpm-store/` remains untouched/untracked.

- [ ] **Step 3: Update README and progress truthfully**

Document macro behavior, provider/test-fixture production gate, exercise/MET catalogs, schema v2-to-v3 structural migration, and local commands. Mark all six phase-3 acceptance boxes complete only after Step 1 passes. Keep these external blockers explicit:

- `CN-DRI-2023` formal table review before production policy revision.
- Nutrition data commercial authorization, caching permission, and provider exit strategy before production data ingestion.
- No claim of live nutrition provider or production-reviewed food database.

Set phase 4 as the next stage and record the exact verification date, test file count, test count, and command outcomes.

- [ ] **Step 4: Re-run documentation-sensitive checks**

Run: `pnpm.cmd lint`

Run: `pnpm.cmd typecheck`

Run: `git diff --check`

Expected: all exit `0` after the documentation update.

- [ ] **Step 5: Commit the acceptance record**

```powershell
git add README.md DEVELOPMENT_PROGRESS.md
git commit -m "docs: complete phase three acceptance"
```

---

## Plan Self-Review

- All six phase-3 acceptance items map to Tasks 1–5.
- Stage-4 inventory versions, weekly meal-plan generation, locks, completion feedback, and outbox consumption remain outside this plan.
- Every production-code task starts with a failing behavior test and an observed RED run.
- No dependency, external call, provider credential, exercise-level MET, or unreviewed production food value is introduced.
- API, persistence, domain, calculation, provider, data, and UI names use the same `DailyNutritionTargetVersion`, `nutrition-policy-v1`, and `nutrition_constraints_infeasible` vocabulary.
