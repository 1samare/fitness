# Phase 2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 2 with atomic initial planning setup, consistent immutable version chains, date-safe affected-day recalculation, durable training-change events, strict CloudBase persistence, and a seven-day native WeChat form.

**Architecture:** Keep the existing one-way page → cloud controller → application service → domain/calculation → persistence adapter flow. Add one composite command that appends the initial profile, goal, plan, daily targets, idempotency result, and outbox event in one user-scoped transaction; independent edit commands remain available and invalidate stale downstream pointers. Pure helpers own canonical request hashing and business-date/change-set logic, while CloudBase persistence enforces structural and semantic aggregate invariants at both read and write boundaries.

**Tech Stack:** Native WeChat Mini Program TypeScript, CloudBase Node.js 20.19 cloud functions, `wx-server-sdk` 4, Zod 4, pnpm 9, TypeScript 5.9 strict mode, Vitest 3, ESLint 9, esbuild 0.25, tsup 8.

## Global Constraints

- Automated personalized energy remains limited to healthy adults ages 18–45, BMI `18.5–<24.0`, completed health exclusion confirmation, and all required inputs.
- Keep `calculation-policy-v2` formulas, PAL values, goal adjustments, MET source rules, units, and rounding unchanged.
- Add `nutrition-policy-v1` metadata only; Phase 2 does not calculate macros, food weights, recipes, or meal plans.
- The client never supplies `userId`, OpenID, MET, version IDs, policy versions, timestamps, event IDs, or database keys.
- Every write carries trusted runtime identity, expected version(s), and an idempotency key.
- Past facts are immutable; only eligible business dates at or after the user business date and goal effective date may receive new daily targets.
- `TrainingPlanChanged` is written to an outbox in the same transaction as the plan version; event consumption remains out of scope.
- `domain` imports no Zod, CloudBase SDK, WeChat API, LangGraph, model SDK, or supplier DTO.
- Strict TypeScript remains enabled; no unjustified `any`, non-null assertions, type escapes, or silent fallback values.
- Do not commit real AppID, EnvId, OpenID, AppSecret, SecretId, SecretKey, user data, `.build`, `dist`, logs, or `project.config.json` personal changes.
- Preserve the current user-owned `project.config.json` modification. Every `git add` command in this plan uses explicit paths and excludes it.
- The existing uncommitted canonicalization test and implementation are intentionally absorbed and replaced by Task 2; do not discard the test intent.
- Every behavior change follows RED → GREEN → REFACTOR and every task ends with an intentional commit and push to `origin/codex/phase-2`.

---

### Task 1: Extend domain and API contracts with strict calendar dates

**Files:**
- Create: `packages/contracts/src/business-date.ts`
- Create: `packages/contracts/src/business-date.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/domain/src/versioned-planning.ts`
- Modify: `packages/calculation/src/policy.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`

**Interfaces:**
- Produces: `isBusinessDate(value: string): boolean`, `addBusinessDays(date: string, days: number): string`, `businessDateSchema`, `planningSetupPayloadSchema`, `PlanningSetupPayload`, `CompletePlanningSetupCommand`, `TrainingPlanChangedEvent`, `LatestPlanningVersions`, `NUTRITION_POLICY_V1`, and updated request/response schemas.
- Consumes: existing `DailyEnergyResult`, profile/goal/training payloads, and `calculation-policy-v2`.

- [x] **Step 1: Write failing calendar-date tests**

Create `packages/contracts/src/business-date.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { addBusinessDays, isBusinessDate } from './business-date';

describe('business dates', () => {
  test.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '26-08-07'])(
    'rejects invalid calendar date %s',
    (value) => { expect(isBusinessDate(value)).toBe(false); }
  );

  test.each(['2024-02-29', '2026-08-07', '2000-01-01'])(
    'accepts real calendar date %s',
    (value) => { expect(isBusinessDate(value)).toBe(true); }
  );

  test('adds days without local-time rollover', () => {
    expect(addBusinessDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addBusinessDays('2024-02-28', 2)).toBe('2024-03-01');
  });
});
```

Extend `packages/contracts/src/planning-api.test.ts` with one request using `effectiveDate: '2026-02-30'` and one using `weekStartDate: '2025-02-29'`; assert both throw. Add a valid `completePlanningSetup` request and assert that adding `userId: 'attacker'` at the action or payload level throws.

- [x] **Step 2: Run the contract tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/contracts/src/business-date.test.ts packages/contracts/src/planning-api.test.ts
```

Expected: FAIL because `business-date.ts`, strict calendar refinement, and `completePlanningSetup` do not exist.

- [x] **Step 3: Implement calendar helpers without silent date normalization**

Create `packages/contracts/src/business-date.ts` with this public shape:

```ts
import { z } from 'zod';

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBusinessDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

export function addBusinessDays(value: string, days: number): string {
  if (!isBusinessDate(value) || !Number.isInteger(days)) {
    throw new Error('Invalid business date arithmetic input');
  }
  const candidate = new Date(`${value}T00:00:00.000Z`);
  candidate.setUTCDate(candidate.getUTCDate() + days);
  return candidate.toISOString().slice(0, 10);
}

export const businessDateSchema = z.string().refine(isBusinessDate, {
  message: 'Expected a real calendar date in YYYY-MM-DD format'
});
```

Export it from `packages/contracts/src/index.ts`. Replace the regex-only date schema in `planning-api.ts` with this schema.

- [x] **Step 4: Add the approved domain records**

Update `packages/domain/src/versioned-planning.ts` with these exact concepts:

```ts
export interface LatestPlanningVersions {
  readonly bodyProfile: number;
  readonly goal: number;
  readonly trainingPlan: number;
}

export interface CompletePlanningSetupCommand {
  readonly expectedVersions: LatestPlanningVersions;
  readonly idempotencyKey: string;
  readonly bodyProfile: BodyProfilePayload;
  readonly goal: GoalPayload;
  readonly trainingPlan: TrainingPlanPayload;
}

export interface TrainingPlanChangedEvent {
  readonly eventId: string;
  readonly eventType: 'TrainingPlanChanged';
  readonly userId: string;
  readonly previousTrainingPlanVersionId: string | null;
  readonly trainingPlanVersionId: string;
  readonly bodyProfileVersionId: string;
  readonly goalVersionId: string;
  readonly affectedDates: readonly string[];
  readonly occurredAt: string;
  readonly status: 'pending';
}
```

Add `nutritionPolicyVersion: 'nutrition-policy-v1'` to `DailyEnergyTargetVersion`, add `outboxEvents` to `PlanningAggregateState`, add `latestVersions` to `CurrentPlanningContext`, and add `completePlanningSetup` to `PlanningWriteOperation`/`IdempotencyRecord` with a structured result containing the three version IDs, daily-target IDs, and event ID.

- [x] **Step 5: Add versioned nutrition policy metadata**

Extend `packages/calculation/src/policy.ts`:

```ts
export const NUTRITION_POLICY_V1 = Object.freeze({
  policyVersion: 'nutrition-policy-v1' as const,
  sourceIds: ['CN-DRI-2023', 'CN-DRI-MACRO-2017'] as const,
  applicableAgeRange: { minInclusive: 18 as const, maxInclusive: 45 as const },
  applicableBmiRange: { minInclusive: 18.5 as const, maxExclusive: 24 as const },
  effectiveDate: '2026-08-07',
  reviewedAt: '2026-08-07'
});
```

Do not add nutrition constants or calculations in this task.

- [x] **Step 6: Extend strict request, response, stored-state, event, and error schemas**

In `packages/contracts/src/planning-api.ts`:

- Export a strict `planningSetupPayloadSchema` containing only `bodyProfile`, `goal`, and `trainingPlan`, plus its inferred `PlanningSetupPayload` type for the mini-program form builder.
- Add `completePlanningSetup` with a strict payload matching `CompletePlanningSetupCommand`.
- Add success kind `planning_setup_completed` containing public profile, goal, training plan, `dailyEnergyTargets` with length `0..7`, and `affectedDates`.
- Change `training_plan_saved.dailyEnergyTargets` from exactly seven to at most seven.
- Add `latestVersions` to `current_context`.
- Add `nutritionPolicyVersion` to daily targets.
- Add stored outbox event and composite idempotency schemas.
- Add errors `invalid_calendar_date`, `past_training_change_forbidden`, and `training_date_outside_goal_period`.

All objects remain `.strict()` and no public schema exposes `userId`.

- [x] **Step 7: Adapt existing producers to the new required fields**

Before the composite service exists, keep the existing three-write flow green by adding `outboxEvents: []` to both repository empty states, adding `nutritionPolicyVersion: 'nutrition-policy-v1'` to current daily-target creation/public mapping, and adding history-length `latestVersions` to `getCurrentContext`/the public response. Update the existing handler isolation expectation to include zero version counts. Do not implement or route `completePlanningSetup` in this compatibility step.

- [x] **Step 8: Verify GREEN, typecheck, commit, and push**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/contracts/src/business-date.test.ts packages/contracts/src/planning-api.test.ts
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd lint
git diff --check
git add -- packages/contracts packages/domain/src/versioned-planning.ts packages/calculation/src/policy.ts packages/application/src/versioned-planning.ts packages/persistence/src/in-memory-planning-repository.ts packages/persistence/src/cloudbase-planning-repository.ts packages/persistence/src/versioned-planning.test.ts cloudfunctions/planning-api/src/handler.ts cloudfunctions/planning-api/src/handler.test.ts docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "feat: extend phase two planning contracts"
git push origin codex/phase-2
```

Expected: targeted tests, typecheck, and lint pass; `project.config.json` remains unstaged.

---

### Task 2: Replace raw JSON fingerprints with versioned canonical SHA-256

**Files:**
- Create: `packages/application/src/idempotency-fingerprint.ts`
- Create: `packages/application/src/idempotency-fingerprint.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`

**Interfaces:**
- Produces: `requestFingerprint(value: unknown): string` returning `v2:sha256:<64 lowercase hex>`.
- Consumes: JSON-compatible, schema-validated command objects.

- [x] **Step 1: Move the existing test intent into focused failing tests**

Create `packages/application/src/idempotency-fingerprint.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { requestFingerprint } from './idempotency-fingerprint';

describe('requestFingerprint', () => {
  test('ignores object insertion order at every depth', () => {
    const left = { expectedVersion: 0, payload: { goal: 'maintain', dates: { from: '2026-08-07', to: '2026-08-14' } } };
    const right = { payload: { dates: { to: '2026-08-14', from: '2026-08-07' }, goal: 'maintain' }, expectedVersion: 0 };
    expect(requestFingerprint(left)).toBe(requestFingerprint(right));
  });

  test('preserves array order', () => {
    expect(requestFingerprint({ sessions: ['02054', 'rest'] }))
      .not.toBe(requestFingerprint({ sessions: ['rest', '02054'] }));
  });

  test('uses a deterministic total order for distinct Unicode keys', () => {
    expect(requestFingerprint({ '\u00e9': 1, 'e\u0301': 2 }))
      .toBe(requestFingerprint({ 'e\u0301': 2, '\u00e9': 1 }));
  });

  test('stores only a versioned digest', () => {
    expect(requestFingerprint({ healthScopeConfirmed: true }))
      .toMatch(/^v2:sha256:[0-9a-f]{64}$/);
  });
});
```

Keep the existing persistence-level replay test, but remove the temporary inline `canonicalizeJson` implementation from `versioned-planning.ts` only after RED is observed.

- [x] **Step 2: Run tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/application/src/idempotency-fingerprint.test.ts packages/persistence/src/versioned-planning.test.ts
```

Expected: FAIL because the focused module does not exist and the current `localeCompare`/raw JSON implementation does not produce a versioned digest.

- [x] **Step 3: Implement canonical SHA-256**

Create `idempotency-fingerprint.ts` using `createHash` from `node:crypto`. The comparator must be:

```ts
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
```

Canonicalize arrays in place order; sort object entries with `compareCodeUnits`; omit object properties whose value is `undefined`; serialize once and return:

```ts
return `v2:sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
```

Replace all service fingerprint calls with `requestFingerprint` and export the helper from `packages/application/src/index.ts`.

- [x] **Step 4: Verify GREEN, commit, and push**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/application/src/idempotency-fingerprint.test.ts packages/persistence/src/versioned-planning.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
git diff --check
git add -- packages/application/src/idempotency-fingerprint.ts packages/application/src/idempotency-fingerprint.test.ts packages/application/src/index.ts packages/application/src/versioned-planning.ts packages/persistence/src/versioned-planning.test.ts docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "fix: canonicalize planning idempotency fingerprints"
git push origin codex/phase-2
```

Expected: the existing uncommitted fingerprint patch is fully represented by the committed focused implementation and tests; no unrelated file is staged.

---

### Task 3: Implement atomic setup, chain invalidation, affected dates, and outbox events

**Files:**
- Create: `packages/application/src/business-time.ts`
- Create: `packages/application/src/business-time.test.ts`
- Create: `packages/application/src/training-plan-change.ts`
- Create: `packages/application/src/training-plan-change.test.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/versioned-planning.test.ts`

**Interfaces:**
- Produces: `businessDateAt(isoInstant, timeZone)`, `affectedTrainingDates(previous, next, eligibleDates)`, `service.completePlanningSetup(userId, command)`, consistent `getCurrentContext`, and durable `TrainingPlanChanged` records.
- Consumes: strict commands from Task 1 and fingerprints from Task 2.

- [x] **Step 1: Write failing pure time and change-set tests**

Create `business-time.test.ts` covering UTC day crossover:

```ts
expect(businessDateAt('2026-08-06T16:30:00.000Z', 'Asia/Shanghai')).toBe('2026-08-07');
expect(() => businessDateAt('2026-08-06T16:30:00.000Z', 'Asia/Not_A_Zone')).toThrow();
```

Create `training-plan-change.test.ts` with literal expectations:

```ts
expect(affectedTrainingDates(
  [{ businessDate: '2026-08-10', sessionCode: '02054', durationMinutes: 60 }],
  [{ businessDate: '2026-08-12', sessionCode: '02054', durationMinutes: 60 }],
  ['2026-08-10', '2026-08-11', '2026-08-12']
)).toEqual(['2026-08-10', '2026-08-12']);
```

Add cases for duration change, cancellation, unchanged input, and exclusion of an ineligible past date.

- [x] **Step 2: Add failing service tests one behavior at a time**

In `packages/persistence/src/versioned-planning.test.ts`, add separate tests for:

1. `completePlanningSetup` creates profile v1, goal v1, plan v1, eligible daily targets, one idempotency record, and one pending event in one transaction.
2. A goal validation failure leaves every aggregate array empty.
3. Replaying the same composite command returns the same IDs and leaves array lengths unchanged.
4. Saving profile v2 clears active goal/plan; `latestVersions` remains `{ bodyProfile: 2, goal: 1, trainingPlan: 1 }`.
5. Saving goal v2 clears active plan and requires the current profile.
6. A past session change throws `past_training_change_forbidden` without writes.
7. Moving a future session appends targets only for the old/new dates and stores those exact event dates.
8. A new week creates initial targets only for dates within `max(today, effectiveDate)..targetDate`.
9. Every new target contains both policy version fields and complete version IDs.

Use `now: () => '2026-08-07T00:00:00.000Z'` and `businessTimezone: 'Asia/Shanghai'` so expectations are deterministic.

- [x] **Step 3: Run targeted tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/application/src/business-time.test.ts packages/application/src/training-plan-change.test.ts packages/persistence/src/versioned-planning.test.ts
```

Expected: FAIL on missing helpers, missing composite method/event state, stale active pointers, and seven-day unconditional recalculation.

- [x] **Step 4: Implement pure time and affected-date helpers**

`businessDateAt` must use `Intl.DateTimeFormat(...).formatToParts()` with the requested IANA timezone, assemble a literal `YYYY-MM-DD`, and validate the result with `isBusinessDate`.

`training-plan-change.ts` must map sessions by business date and compare only `sessionCode` plus `durationMinutes`. Export:

```ts
export function affectedTrainingDates(
  previous: readonly TrainingSessionPayload[],
  next: readonly TrainingSessionPayload[],
  eligibleDates: readonly string[]
): string[];
```

The result is unique and ascending.

- [x] **Step 5: Refactor version appends into transaction-local pure operations**

Inside `versioned-planning.ts`, keep repository access only at public service methods. Extract private pure operations that accept a state and return `{ nextState, result }` for profile, goal, and training writes. Required behavior:

- Profile append sets `activeGoalVersionId` and `activeTrainingPlanVersionId` to `null`.
- Goal append requires current profile and sets `activeTrainingPlanVersionId` to `null`.
- Training append validates the active chain, business date, goal interval, unique week dates, and past-change rules.
- Daily target version numbers are counted per business date.
- Training write appends one outbox event with the exact affected dates.
- Same-week updates calculate only changed eligible dates; a different week initializes each eligible date.
- `getCurrentContext` returns null/empty for stale links, returns `latestVersions` from history lengths, and selects the latest applicable target per active-week date.

Introduce errors with exact codes:

```ts
PastTrainingChangeError.code = 'past_training_change_forbidden'
TrainingDateOutsideGoalPeriodError.code = 'training_date_outside_goal_period'
```

- [x] **Step 6: Implement `completePlanningSetup` as one repository transaction**

The method must compute one fingerprint before entering the transaction, check/replay the composite idempotency record, assert all three expected counts, and call the private append operations without starting nested transactions. It must add exactly one composite idempotency record after all appends succeed. Return:

```ts
{
  bodyProfile,
  goal,
  trainingPlan,
  dailyEnergyTargets,
  affectedDates
}
```

On replay, resolve every stored result ID and fail closed if any is missing. No partial record may be persisted when an operation throws.

- [x] **Step 7: Verify GREEN and all application/persistence tests**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/application/src/business-time.test.ts packages/application/src/training-plan-change.test.ts packages/persistence/src/versioned-planning.test.ts
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: all tests pass; the full suite has more than the previous 60 tests.

- [x] **Step 8: Commit and push**

```powershell
git diff --check
git add -- packages/application packages/persistence/src/in-memory-planning-repository.ts packages/persistence/src/versioned-planning.test.ts docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "feat: add atomic versioned planning setup"
git push origin codex/phase-2
```

---

### Task 4: Enforce CloudBase aggregate invariants and schema version 2

**Files:**
- Create: `packages/persistence/src/planning-aggregate-invariants.ts`
- Create: `packages/persistence/src/planning-aggregate-invariants.test.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.test.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**
- Produces: `assertPlanningAggregateInvariants(state, userId): void` and `CorruptPlanningStateError`.
- Consumes: Task 1 structural schema and Task 3 version/event state.

- [x] **Step 1: Write failing invariant tests**

Create a valid aggregate through the real application service, clone it, mutate one invariant per test, and assert `CorruptPlanningStateError` for:

- body profile versions `[1, 3]`;
- duplicate entity IDs;
- active pointer to a missing entity;
- goal referencing a missing profile;
- daily target version gap for one business date;
- composite idempotency result referencing a missing event or target;
- outbox event referencing a missing training plan;
- any version/event belonging to another trusted user.

Do not assert against mocks; invoke the real invariant function and CloudBase repository decoder.

- [x] **Step 2: Run tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/persistence/src/planning-aggregate-invariants.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts
```

Expected: FAIL because semantic invariants and schema version 2 are absent.

- [x] **Step 3: Implement semantic validation**

The invariant module must:

- validate ownership for versions and events;
- validate unique IDs and operation-scoped idempotency keys;
- validate contiguous version sequences globally for profile/goal/plan and per date for daily targets;
- validate active pointers;
- validate all cross-version references;
- validate idempotency result references by discriminated operation;
- validate outbox event references and sorted unique `affectedDates`.

Throw only `CorruptPlanningStateError`; do not repair or normalize stored data.

- [x] **Step 4: Apply invariants at both CloudBase boundaries**

Move `CorruptPlanningStateError` to the invariant module. In `decodeDocument`, require `schemaVersion === 2`, run Zod parsing, then semantic invariants. In `encodeDocument`, run the same validations before `set`. Keep document keys as SHA-256 of trusted OpenID.

There is no v1 migration because no real environment has received Phase 2 data; document this in Task 8.

- [x] **Step 5: Verify, commit, and push**

```powershell
& .\node_modules\.bin\vitest.CMD run packages/persistence/src/planning-aggregate-invariants.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd lint
git diff --check
git add -- packages/persistence docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "feat: enforce planning aggregate invariants"
git push origin codex/phase-2
```

---

### Task 5: Expose the composite command through the trusted cloud controller

**Files:**
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/index.test.ts`

**Interfaces:**
- Produces: public `planning_setup_completed` and updated `current_context` responses.
- Consumes: trusted `OPENID`, strict Task 1 contracts, and Task 3 service.

- [x] **Step 1: Write failing handler tests**

Add tests that:

- reject `completePlanningSetup` without trusted context;
- reject client `userId` as `invalid_request`;
- call the composite action with a trusted user and receive all public versions, affected dates, daily targets, and no `userId` anywhere in the JSON response;
- replay the same request and receive identical IDs;
- map past-date and goal-period errors to their stable codes;
- return `latestVersions` for an empty and populated context.

- [x] **Step 2: Run handler tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts cloudfunctions/planning-api/src/index.test.ts
```

Expected: FAIL because the action, public mapping, error mapping, and version counters are missing.

- [x] **Step 3: Implement controller wiring**

Add `completePlanningSetup` to `knownActions` and `authenticatedActions`. Add a public mapper for composite results and include `nutritionPolicyVersion` in daily target responses. `currentContextResponse` must include literal history counts from `context.latestVersions`.

Map known domain errors without logging payloads or OpenID. Continue returning a generic Chinese message for `internal_error`.

- [x] **Step 4: Verify build boundary, commit, and push**

```powershell
& .\node_modules\.bin\vitest.CMD run cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts cloudfunctions/planning-api/src/index.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
git diff --check
git add -- cloudfunctions/planning-api/src docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "feat: expose atomic planning setup API"
git push origin codex/phase-2
```

---

### Task 6: Build the seven-day structured form from reviewed sessions

**Files:**
- Modify: `data/met-sessions/src/reviewed-met-sessions.ts`
- Modify: `data/met-sessions/src/reviewed-met-sessions.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `miniprogram/pages/planning-setup/form.ts`
- Modify: `miniprogram/pages/planning-setup/form.test.ts`

**Interfaces:**
- Produces: `displayNameZh` in reviewed session data, `TrainingDayFormInput`, `buildTrainingDayRows`, and `buildPlanningSetupPayload` for zero-to-seven sessions.
- Consumes: `businessDateSchema`/`addBusinessDays` and the reviewed MET catalog; never consumes raw MET in the page payload.

- [x] **Step 1: Write failing catalog and form tests**

Extend the MET fixture expectation with:

```ts
displayNameZh: '多动作抗阻训练'
```

Replace the single-session form tests with table-driven tests that prove:

- a disabled seven-row week creates `sessions: []`;
- seven enabled rows create seven sessions in date order;
- two enabled rows preserve their selected `sessionCode` and numeric duration;
- an enabled row without session code or duration is rejected;
- a disabled or past row is omitted;
- changing `weekStartDate` yields seven exact consecutive business dates across a month boundary;
- the result is a payload only, with no `userId`, MET, IDs, timestamps, versions, or idempotency key.

- [x] **Step 2: Run tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run data/met-sessions/src/reviewed-met-sessions.test.ts miniprogram/pages/planning-setup/form.test.ts
```

Expected: FAIL because the catalog label and seven-row form model do not exist.

- [x] **Step 3: Make the reviewed catalog consumable by the mini program**

Add `displayNameZh` without changing MET, source ID, dataset version, review date, or English source description. Add `@fitness/met-sessions: workspace:*` to root `devDependencies` and run:

```powershell
pnpm.cmd install --lockfile-only
```

The lockfile change must contain only the workspace link needed by the root mini-program build.

- [x] **Step 4: Implement the pure seven-day form builder**

Replace `trainingDate`/`durationMinutes` with:

```ts
export interface TrainingDayFormInput {
  readonly businessDate: string;
  readonly enabled: boolean;
  readonly disabled: boolean;
  readonly sessionCode: string;
  readonly durationMinutes: string;
}
```

`buildTrainingDayRows(weekStartDate, businessToday, goalEffectiveDate, goalTargetDate)` returns seven rows and marks dates before `max(today, effectiveDate)` or after `targetDate` disabled. `buildPlanningSetupPayload(form)` validates profile/goal fields and maps enabled, non-disabled rows to sessions. It calls the strict request schema or exported payload schemas before returning `kind: 'valid'` so the page cannot construct an invalid domain command.

Export the version type used by Task 7 directly from the inferred composite request instead of duplicating it:

```ts
type SetupRequest = Extract<PlanningApiRequest, { action: 'completePlanningSetup' }>;
export type PlanningVersions = SetupRequest['payload']['expectedVersions'];
```

- [x] **Step 5: Verify, commit, and push**

```powershell
& .\node_modules\.bin\vitest.CMD run data/met-sessions/src/reviewed-met-sessions.test.ts miniprogram/pages/planning-setup/form.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build:miniprogram
git diff --check
git add -- data/met-sessions package.json pnpm-lock.yaml miniprogram/pages/planning-setup/form.ts miniprogram/pages/planning-setup/form.test.ts docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "feat: add structured weekly training form model"
git push origin codex/phase-2
```

---

### Task 7: Submit once and preserve retries across response loss

**Files:**
- Create: `miniprogram/pages/planning-setup/pending-command.ts`
- Create: `miniprogram/pages/planning-setup/pending-command.test.ts`
- Modify: `miniprogram/pages/planning-setup/index.ts`
- Modify: `miniprogram/pages/planning-setup/index.wxml`
- Modify: `miniprogram/pages/planning-setup/index.wxss`
- Modify: `miniprogram/services/planning-api.test.ts`

**Interfaces:**
- Produces: one composite request per logical form payload, persisted under `fitness.pendingPlanningSetup.v1` until a validated success response.
- Consumes: Task 5 API and Task 6 normalized payload/catalog.

- [ ] **Step 1: Write failing pending-command tests**

Create pure tests proving:

1. No pending command + payload + latest versions creates a command using `nextKey()` exactly once.
2. Same normalized payload reuses the stored request even when newly fetched versions would differ.
3. Different payload creates a new command and key.
4. The pending record contains the full validated request required for retry but no response or user identity.

Use a literal pending record and assert complete request equality; do not mock `wx`.

- [ ] **Step 2: Run tests and verify RED**

```powershell
& .\node_modules\.bin\vitest.CMD run miniprogram/pages/planning-setup/pending-command.test.ts miniprogram/pages/planning-setup/form.test.ts miniprogram/services/planning-api.test.ts
```

Expected: FAIL because pending command selection and composite page calls do not exist.

- [ ] **Step 3: Implement pure pending command selection**

Define:

```ts
export interface PendingPlanningSetup {
  readonly payloadFingerprint: string;
  readonly request: Extract<PlanningApiRequest, { action: 'completePlanningSetup' }>;
}

export function selectPlanningSetupCommand(input: {
  readonly payload: PlanningSetupPayload;
  readonly latestVersions: PlanningVersions;
  readonly pending: PendingPlanningSetup | undefined;
  readonly nextKey: () => string;
}): { readonly pending: PendingPlanningSetup; readonly reused: boolean };
```

The client fingerprint may be deterministic JSON of the normalized fixed-shape payload because it stays only in private local storage; the server remains authoritative with SHA-256.

- [ ] **Step 4: Replace sequential page writes with one recoverable call**

Update page flow in this order:

1. Build and validate the normalized form payload.
2. Load `fitness.pendingPlanningSetup.v1` with `wx.getStorageSync`.
3. If the pending payload matches, reuse its full request without fetching versions.
4. Otherwise call `getCurrentContext`, use `latestVersions`, create one composite request, and persist it with `wx.setStorageSync` before network I/O.
5. Call `planningApiClient.call(request)` exactly once.
6. On `planning_setup_completed`, remove pending storage and show returned targets.
7. On transport failure, retain pending storage for retry.
8. On deterministic validation/idempotency conflict, show the error and retain the command until the user changes the form or explicitly retries.

Use a Shanghai business-date helper for disabling rows; server validation remains authoritative.

- [ ] **Step 5: Render seven editable rows**

`index.wxml` must use `wx:for` over `trainingDays`. Each row renders date, enabled switch, reviewed-session picker, and duration input. Event handlers update indexed fields using `data-index`. Disabled rows show “过去日期不可改” or “目标周期外”. Remove the hard-coded `02054` copy and read labels/codes from the reviewed catalog.

Update CSS with `.training-day`, `.training-day__header`, `.training-day--disabled`, and compact picker/input states. Keep estimates/non-medical copy unchanged.

- [ ] **Step 6: Verify page logic, build, commit, and push**

```powershell
& .\node_modules\.bin\vitest.CMD run miniprogram/pages/planning-setup/pending-command.test.ts miniprogram/pages/planning-setup/form.test.ts miniprogram/services/planning-api.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build:miniprogram
pnpm.cmd build:miniprogram:local
git diff --check
git add -- miniprogram/pages/planning-setup miniprogram/services/planning-api.test.ts docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "feat: submit recoverable weekly planning setup"
git push origin codex/phase-2
```

---

### Task 8: Produce a deployable CloudBase artifact and reconcile documentation

**Files:**
- Create: `scripts/build-cloudfunction-deploy.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/cloudbase/phase-2-deployment.md`
- Modify: `cloudbaserc.json` only if its checked-in generic paths no longer match the generated artifact

**Interfaces:**
- Produces: ignored `.build/cloudfunctions/planning-api/index.js` plus a dependency-free package manifest, and exact sanitized deployment/acceptance instructions.
- Consumes: bundled `cloudfunctions/planning-api/dist/index.js`; no real AppID/EnvId is written.

- [ ] **Step 1: Add a failing artifact smoke check**

Create the build script so it fails before implementation when `dist/index.js` is missing. Its postcondition must be verifiable with:

```powershell
pnpm.cmd --filter @fitness/planning-api build
node scripts/build-cloudfunction-deploy.mjs
node -e "const fn=require('./.build/cloudfunctions/planning-api/index.js'); if(typeof fn.main!=='function') process.exit(1)"
```

Expected before the script exists: command fails. Expected after implementation: exit `0` and no network access.

- [ ] **Step 2: Implement safe artifact generation**

The script resolves repository paths from `import.meta.url`, verifies that the cleanup target is exactly `.build/cloudfunctions/planning-api`, removes only that directory, copies `dist/index.js`, and writes this generated manifest:

```json
{
  "name": "planning-api",
  "version": "0.1.0",
  "private": true,
  "main": "index.js"
}
```

Do not copy source maps, source files, workspace manifests, node_modules, or secrets. Add the script to root `build` after workspace builds and before the mini-program build.

- [ ] **Step 3: Update documentation to actual behavior**

README and deployment docs must state:

- first setup is atomic and retry-safe;
- current context exposes history counts and only a consistent active chain;
- same-week plan changes recalculate only affected future dates and write a pending outbox event;
- `nutrition-policy-v1` is traceability metadata, not macro generation;
- CloudBase stored schema starts at version 2 because no Phase 2 data was previously deployed;
- real AppID/EnvId remain local;
- second WeChat is still required before declaring dual-user cloud acceptance complete.

Document environment selection through local variables so no real value is committed:

```powershell
$phase2Repo = (Resolve-Path '.').Path
$phase2Project = Get-Content -Raw -Encoding UTF8 project.config.json | ConvertFrom-Json
$phase2AppId = [string]$phase2Project.appid
$phase2EnvId = $env:FITNESS_PHASE2_ENV_ID
$wechatCli = 'D:\Program Files\微信web开发者工具\cli.bat'
if ([string]::IsNullOrWhiteSpace($phase2EnvId)) { throw 'FITNESS_PHASE2_ENV_ID is required' }
if ($phase2AppId -eq 'touristappid') { throw 'A real local AppID is required' }
& $wechatCli cloud functions deploy --env $phase2EnvId --paths (Join-Path $phase2Repo '.build\cloudfunctions\planning-api') --appid $phase2AppId
& $wechatCli cloud functions list --env $phase2EnvId --appid $phase2AppId
```

- [ ] **Step 4: Verify, commit, and push**

```powershell
pnpm.cmd build
node -e "const fn=require('./.build/cloudfunctions/planning-api/index.js'); if(typeof fn.main!=='function') process.exit(1)"
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
git diff --check
git add -- scripts/build-cloudfunction-deploy.mjs package.json README.md docs/cloudbase/phase-2-deployment.md cloudbaserc.json docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git diff --cached --name-only
git commit -m "build: add CloudBase deployment artifact"
git push origin codex/phase-2
```

Before committing, remove `cloudbaserc.json` from the index if unchanged. Confirm `project.config.json` is not staged.

---

### Task 9: Run the full gate, deploy to the authorized development environment, and record acceptance

**Files:**
- Modify: `docs/superpowers/plans/2026-08-07-phase-2-hardening.md` checkboxes only as evidence is obtained
- Create locally but do not commit: `logs/phase-2-cloudbase-acceptance.md`

**Interfaces:**
- Produces: fresh automated evidence, remote commits, one deployed `planning-api` development function, and a private acceptance record.
- Consumes: the user-provided local AppID/EnvId and authenticated Developer Tools session.

- [ ] **Step 1: Invoke verification-before-completion and run the complete automated gate**

Run fresh, in order:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd build:miniprogram:local
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
git diff --check
```

Expected: every command exits `0`; capture current test file/test counts and smoke count.

- [ ] **Step 2: Audit security, boundaries, generated files, and commit scope**

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!**/dist/**' --glob '!.build/**' --glob '!.git/**' '(AKID[A-Za-z0-9]{16,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:secretId|secretKey|apiKey|accessKey)\s*[:=])' .
rg -n "from ['\"](@cloudbase|wx-server-sdk|langgraph|@langchain)|\bwx\." packages/domain packages/calculation
rg -n "userId" miniprogram
git status --short --untracked-files=all
git diff --stat
git diff --cached --stat
```

Expected: no secrets; no forbidden domain/calculation imports; no client `userId`; generated artifacts absent from status; `project.config.json` remains an unstaged personal modification.

- [ ] **Step 3: Record automated verification and confirm every implementation commit is remote**

If the audit finds a code problem, return to the task that owns that file and repeat its RED/GREEN/commit cycle. When the gate is clean, check off completed Tasks 1–8 in this plan and stage only the plan record. Never run `git add .` or stage `project.config.json`.

```powershell
git add -- docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git diff --cached --name-only
git commit -m "docs: record phase two implementation verification"
git push origin codex/phase-2
git status --short --branch
git rev-parse HEAD
git rev-parse origin/codex/phase-2
```

Expected: local and remote SHA match; only intentional personal/local evidence files remain uncommitted or ignored.

- [ ] **Step 4: Verify Developer Tools login and the exact environment before mutation**

Use the installed Developer Tools CLI to run `islogin` and `cloud env list` for this project. Confirm the returned AppID and EnvId match the user-provided local values. If either differs, stop before deployment and request correction.

- [ ] **Step 5: Deploy the generated function and verify its presence**

Run the documented `cloud functions deploy` command against `.build/cloudfunctions/planning-api`, then `cloud functions list` for the same environment. Record the function name, runtime/version information returned by the tool, timestamp, and command exit status in ignored `logs/phase-2-cloudbase-acceptance.md`.

Apply `cloudbase/database.rules.json` and `cloudbase/function.rules.json` through the authenticated CloudBase console. Capture rule publication timestamps in the local acceptance record; do not store account names, OpenID, tokens, cookies, or screenshots containing personal data in Git.

- [ ] **Step 6: Complete account A cloud acceptance**

In the developer/preview build, use account A to:

1. Submit a valid zero-training or reviewed-session setup once.
2. Simulate/retry the same request and confirm identical version IDs.
3. Reuse its key with a changed payload and confirm `idempotency_key_reused`.
4. Submit a stale expected version and confirm `version_conflict`.
5. Inspect returned daily targets for all five required version references.
6. Move/cancel a future session and confirm only affected dates gain versions and the outbox event has the exact date set.

Record only anonymous labels (`user-A`) and version/event IDs that contain no OpenID.

- [ ] **Step 7: Complete account B isolation when the second微信 is added**

Add the second微信 as an experience member, open the same build, and confirm its current context is empty before it writes. Then create its own setup and confirm account A still sees only A's versions. Record pass/fail with anonymous labels.

If account B is not yet available, leave this checkbox open and state that code, deployment, and single-account acceptance are complete but full Phase 2 cloud acceptance is not.

- [ ] **Step 8: Final completion audit**

Map every approved spec section to authoritative evidence: tests for behavior, Git SHAs for submitted code, CLI output for deployment, console evidence for rules, and two-device behavior for isolation. Only when every item—including Step 7—has evidence may the active goal be marked complete.

After all evidence exists, check off the remaining Task 9 steps, stage only this plan, commit, and push:

```powershell
git add -- docs/superpowers/plans/2026-08-07-phase-2-hardening.md
git commit -m "docs: record phase two cloud acceptance"
git push origin codex/phase-2
```

## Plan Self-Review Mapping

- Strict dates, composite schemas, policy reference, event/storage shapes: Task 1.
- Canonical versioned SHA-256 and old uncommitted patch absorption: Task 2.
- Atomic rollback/replay, downstream invalidation, history counters, business date, affected dates, and outbox: Task 3.
- Ownership, continuity, pointers, cross-references, idempotency results, and event invariants: Task 4.
- Trusted OpenID controller, public DTOs, stable errors, and response validation: Task 5.
- Reviewed catalog and zero-to-seven structured sessions: Task 6.
- One-call setup and response-loss retry persistence: Task 7.
- Deployable bundle, accurate docs, and no committed environment identifiers: Task 8.
- Full automated gate, security audit, remote submission, real CloudBase deployment, rules, idempotency/conflict checks, and two-user isolation: Task 9.
- No macros, recipes, LLM, image recognition, external nutrition provider, or event consumer: Global Constraints and Tasks 1/8.
