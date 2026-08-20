# Phase 7A Personal Data Rights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add schema-v8 account lifecycle protection, white-listed personal-data access/export, retry-safe account deletion, transactional assistant-summary consistency, and tester-facing privacy/data-rights pages.

**Architecture:** Keep the existing per-user aggregate as the deletion consistency boundary. A raw `PersonalDataRepository` is available only to `PersonalDataService`; all planning, assistant, meal, and photo services receive an `AccountDeletionGuardedRepository`, so a pending deletion stops normal use while the same delete command can finish. The mini program exposes only strict public DTOs and clears all app-local state after terminal deletion.

**Tech Stack:** TypeScript 5.9 strict mode, Zod, Vitest, CloudBase document transactions/private storage, native WeChat mini program, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-20-phase-7-cloud-integration-controlled-beta-design.md`

## Global Constraints

- Work only on `feat/v1.0`; do not create a branch or worktree.
- Do not add a framework or dependency in this sub-plan.
- Schema v8 reads v2-v8 and writes v8; v2-v7 migration adds only `accountDeletion: null`.
- The application aggregate limit is exactly `3_000_000` UTF-8 JSON bytes and the CloudBase synchronous response ceiling is treated as 6 MB.
- `planning_user_states` remains the only user aggregate collection; successful deletion removes the whole document and writes no user tombstone.
- Client-supplied `userId` remains forbidden. Identity comes only from trusted OpenID.
- Export is an explicit whitelist. It must not expose OpenID/userId, database IDs, private file IDs/paths/URLs, provider raw fields, idempotency records, pending commands, request fingerprints, or internal cleanup fields.
- Deletion requires the current snapshot token, a new idempotency key, exact server confirmation `DELETE_MY_ACCOUNT`, and exact page confirmation `删除我的账户`.
- Storage `deleted` and `not_found` are success; any other storage result retains the full aggregate and pending marker for exact-command retry.
- All deterministic energy, macro, gram, and training values remain labeled as estimates and non-medical output.
- Every implementation task follows RED → GREEN → focused regression → commit.

---

### Task 1: Schema-v8 Aggregate and Privileged Repository Boundary

**Files:**
- Modify: `packages/domain/src/versioned-planning.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Create: `packages/application/src/personal-data-repository.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/persistence/src/cloudbase-planning-repository.test.ts`
- Test: `packages/persistence/src/planning-aggregate-invariants.test.ts`
- Test: `packages/persistence/src/versioned-planning.test.ts`
- Test: `cloudfunctions/planning-api/src/wx-database-adapter.test.ts`
- Create: `cloudfunctions/assistant-api/src/wx-database-adapter.test.ts`

**Interfaces:**
- Consumes: existing `PlanningRepository.read` and `PlanningRepository.transact`.
- Produces:

```ts
export interface PendingAccountDeletion {
  readonly status: 'pending';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly snapshotToken: string;
  readonly requestedAt: string;
  readonly privateFileIds: readonly string[];
}

export interface PersonalDataRepository extends PlanningRepository {
  readExisting(userId: string): Promise<PlanningAggregateState | null>;
  deleteExisting<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => TResult
  ): Promise<TResult>;
}

export class PersonalDataDocumentNotFoundError extends Error {
  readonly code: 'personal_data_document_not_found';
}
```

- `PlanningAggregateState.accountDeletion` is `PendingAccountDeletion | null`.
- `CloudBaseDocumentReference.remove(): Promise<unknown>` is required by both CloudBase database adapters.

- [x] **Step 1: Add failing schema migration and deletion-boundary tests**

Add assertions that an empty state has `accountDeletion: null`, every v2-v7 document decodes with only that new field, v8 round-trips, `readExisting` distinguishes absence from an empty account, and `deleteExisting` removes the document transactionally:

```ts
it('migrates v7 to v8 without changing historical data', async () => {
  const legacy = validStoredDocument(7);
  const { userId: storedIdentity, ...historicalState } = legacy.state;
  expect(storedIdentity).toBe('user-a');
  const decoded = decodePlanningDocument(legacy, 'user-a');
  expect(decoded).toEqual({ ...historicalState, accountDeletion: null });
});

it('deletes only an existing user document', async () => {
  const repository = new CloudBasePlanningRepository(database);
  expect(await repository.readExisting('missing')).toBeNull();
  await repository.transact('user-a', (state) => ({ nextState: state, result: null }));
  await expect(repository.deleteExisting('user-a', (state) => state.accountDeletion)).resolves.toBeNull();
  expect(await repository.readExisting('user-a')).toBeNull();
});
```

Update both `wx-database-adapter.test.ts` files so a transaction document reference forwards `remove()` exactly once.

- [x] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts packages/persistence/src/versioned-planning.test.ts cloudfunctions/planning-api/src/wx-database-adapter.test.ts cloudfunctions/assistant-api/src/wx-database-adapter.test.ts
```

Expected: FAIL because `accountDeletion`, schema v8, `readExisting`, `deleteExisting`, and document `remove` do not exist.

- [x] **Step 3: Implement the schema and repository primitives**

Add the domain field and the exact privileged interface shown above. Change stored documents to:

```ts
interface StoredPlanningDocument {
  readonly schemaVersion: 8;
  readonly state: PlanningAggregateState & { readonly userId: string };
}

const phase7Empty = { accountDeletion: null } as const;
```

Decode v2-v7 by adding `phase7Empty`; parse v8 without migration. Extend the invariant parser with a strict pending-deletion parser: non-empty strings, ISO `requestedAt`, unique `privateFileIds`, and each file ID matching `^cloud://`. Add `accountDeletion: null` to every empty-state factory.

Implement CloudBase deletion inside `runTransaction`:

```ts
public async deleteExisting<TResult>(
  userId: string,
  operation: (current: PlanningAggregateState) => TResult
): Promise<TResult> {
  const documentId = this.documentIdForUser(userId);
  return this.database.runTransaction(async (transaction) => {
    const reference = transaction.collection(collectionName).doc(documentId);
    const stored = await reference.get();
    if (stored.data === undefined) throw new PersonalDataDocumentNotFoundError();
    const current = decodePlanningDocument(stored.data, userId);
    const result = operation(current);
    await reference.remove();
    return result;
  });
}
```

Give `InMemoryPlanningRepository` the same serialized per-user queue semantics for `readExisting` and `deleteExisting`. Both persistence implementations throw the application-owned `PersonalDataDocumentNotFoundError` when the document disappears so Task 3 can turn a response-loss retry into `already_absent` without making `application` depend on `persistence`.

- [x] **Step 4: Run focused tests and typecheck**

Run:

```powershell
pnpm.cmd test -- packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts packages/persistence/src/versioned-planning.test.ts cloudfunctions/planning-api/src/wx-database-adapter.test.ts cloudfunctions/assistant-api/src/wx-database-adapter.test.ts
pnpm.cmd --filter @fitness/domain typecheck
pnpm.cmd --filter @fitness/application typecheck
pnpm.cmd --filter @fitness/persistence typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add packages/domain packages/application packages/persistence cloudfunctions/planning-api/src/wx-database-adapter.test.ts cloudfunctions/assistant-api/src/wx-database-adapter.test.ts
git commit -m "feat: add schema v8 account lifecycle storage"
```

### Task 2: Aggregate Capacity Gate and Pending-Deletion Guard

**Files:**
- Create: `packages/application/src/planning-aggregate-capacity.ts`
- Create: `packages/application/src/planning-aggregate-capacity.test.ts`
- Create: `packages/application/src/account-deletion-guarded-repository.ts`
- Create: `packages/application/src/account-deletion-guarded-repository.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Test: `packages/persistence/src/cloudbase-planning-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 `PlanningAggregateState.accountDeletion` and `PlanningRepository`.
- Produces:

```ts
export const PLANNING_AGGREGATE_MAX_UTF8_BYTES = 3_000_000;
export function planningAggregateUtf8Bytes(state: PlanningAggregateState): number;
export function assertPlanningAggregateCapacity(state: PlanningAggregateState): void;

export class AccountCapacityExceededError extends Error {
  readonly code: 'account_capacity_exceeded';
}

export class AccountDeletionPendingError extends Error {
  readonly code: 'account_deletion_pending';
}

export function createAccountDeletionGuardedRepository(
  repository: PlanningRepository
): PlanningRepository;
```

- [x] **Step 1: Write RED tests for exact UTF-8 sizing and complete blocking**

```ts
it('counts UTF-8 bytes rather than JavaScript code units', () => {
  const state = stateWithAssistantMessage('健身');
  expect(planningAggregateUtf8Bytes(state)).toBe(
    new TextEncoder().encode(JSON.stringify(state)).byteLength
  );
});

it('blocks both reads and transactions while deletion is pending', async () => {
  const raw = new InMemoryPlanningRepository();
  await raw.transact('user-a', (state) => ({
    nextState: { ...state, accountDeletion: pendingDeletion() },
    result: null
  }));
  const guarded = createAccountDeletionGuardedRepository(raw);
  await expect(guarded.read('user-a')).rejects.toMatchObject({ code: 'account_deletion_pending' });
  await expect(guarded.transact('user-a', (state) => ({ nextState: state, result: null })))
    .rejects.toMatchObject({ code: 'account_deletion_pending' });
});
```

Add persistence tests for `3_000_000` bytes accepted and `3_000_001` bytes rejected before a document write.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/application/src/planning-aggregate-capacity.test.ts packages/application/src/account-deletion-guarded-repository.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts
```

Expected: FAIL because the capacity and guard modules do not exist.

- [x] **Step 3: Implement capacity and guard logic**

Use `TextEncoder` over canonical `JSON.stringify(state)` and throw before every in-memory or CloudBase set. The guarded transaction must inspect `current.accountDeletion` inside the underlying transaction, not via an earlier read:

```ts
transact: (userId, operation) => repository.transact(userId, (current) => {
  if (current.accountDeletion !== null) throw new AccountDeletionPendingError();
  return operation(current);
})
```

The raw personal-data repository remains unguarded. No other service composition may receive it after Task 4.

- [x] **Step 4: Run focused and repository regression tests**

Run:

```powershell
pnpm.cmd test -- packages/application/src/planning-aggregate-capacity.test.ts packages/application/src/account-deletion-guarded-repository.test.ts packages/persistence/src
pnpm.cmd --filter @fitness/application typecheck
pnpm.cmd --filter @fitness/persistence typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add packages/application packages/persistence
git commit -m "feat: guard pending deletion and aggregate capacity"
```

### Task 3: White-listed Personal Data Service and Retry-safe Deletion

**Files:**
- Create: `packages/application/src/personal-data.ts`
- Create: `packages/application/src/personal-data.test.ts`
- Create: `packages/application/src/personal-data-export.ts`
- Create: `packages/application/src/personal-data-export.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**
- Consumes: `PersonalDataRepository`, `PrivatePhotoStorage`, `requestFingerprint`, and `PersonalDataDocumentNotFoundError` from Task 1.
- Produces:

```ts
export interface PersonalDataSummary {
  readonly kind: 'personal_data_summary';
  readonly dataExists: boolean;
  readonly snapshotToken: string | null;
  readonly deletionStatus: 'none' | 'pending';
  readonly capacityStatus: 'within_limit' | 'admin_recovery_required';
  readonly activeVersions: {
    readonly bodyProfile: number;
    readonly goal: number;
    readonly trainingPlan: number;
    readonly inventory: number;
    readonly mealPlan: number;
  };
  readonly counts: {
    readonly bodyProfileVersions: number;
    readonly goalVersions: number;
    readonly trainingPlanVersions: number;
    readonly dailyTargetVersions: number;
    readonly inventoryVersions: number;
    readonly mealPlanVersions: number;
    readonly ingredientPhotoRecords: number;
    readonly assistantMessages: number;
  };
}

export interface PersonalDataExportV1 {
  readonly kind: 'personal_data_export';
  readonly schemaVersion: 'personal-data-export-v1';
  readonly snapshotToken: string;
  readonly exportedAt: string;
  readonly notice: '包含 AI 辅助生成内容与确定性估算；仅供健康成年人健身规划参考，不构成医疗建议。';
  readonly provenance: {
    readonly policyVersions: readonly string[];
    readonly reviewedDataVersionReferences: readonly string[];
  };
  readonly records: readonly PersonalDataExportRecord[];
}

export type PersonalDataExportRecord = {
  readonly category:
    | 'body_profile' | 'fitness_goal' | 'training_plan'
    | 'daily_energy_target' | 'daily_nutrition_target'
    | 'inventory' | 'meal_plan' | 'meal_plan_target_diff' | 'meal_plan_decision'
    | 'training_completion' | 'ingredient_photo_confirmation'
    | 'assistant_message';
  readonly contentOrigin: 'user' | 'ai_assisted' | 'deterministic';
  readonly recordVersion: number | null;
  readonly recordedAt: string | null;
  readonly data: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
};

export interface DeleteAccountCommand {
  readonly snapshotToken: string;
  readonly idempotencyKey: string;
  readonly confirmation: 'DELETE_MY_ACCOUNT';
}

export type DeleteAccountResult =
  | { readonly kind: 'account_deleted'; readonly deletedPrivateFileCount: number }
  | { readonly kind: 'account_already_absent'; readonly deletedPrivateFileCount: 0 };

export interface PersonalDataService {
  getPersonalDataSummary(userId: string): Promise<PersonalDataSummary>;
  exportPersonalData(userId: string, snapshotToken: string): Promise<PersonalDataExportV1>;
  deleteAccount(userId: string, command: DeleteAccountCommand): Promise<DeleteAccountResult>;
}

export function createPersonalDataService(input: {
  readonly repository: PersonalDataRepository;
  readonly storage: PrivatePhotoStorage;
  readonly now: () => string;
}): PersonalDataService;
```

Also produce `PersonalDataSnapshotConflictError` (`personal_data_snapshot_conflict`) and reuse `IdempotencyKeyReuseError` for a different command under the same key.

- [x] **Step 1: Write RED tests for snapshots and explicit export whitelist**

Cover stable SHA-256 for the same normalized state, token changes after a business-state change, token unchanged by `accountDeletion`, an absent account summary with null token/zero active versions, a pending summary exposing only `deletionStatus: 'pending'`, over-budget `admin_recovery_required`, stale export rejection, and a recursive banned-key assertion:

```ts
const banned = /^(userId|openid|_id|expectedCloudPath|expectedPrivateFileId|privateFileId|providerRequestId|idempotencyRecords|accountDeletion|requestFingerprint|nextPhotoCleanupAt)$/i;

function assertNoBannedKeys(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertNoBannedKeys);
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(banned);
    assertNoBannedKeys(child);
  }
}

it('exports only public user-facing records', async () => {
  const summary = await service.getPersonalDataSummary('user-a');
  if (summary.snapshotToken === null) throw new Error('expected personal data');
  const exported = await service.exportPersonalData('user-a', summary.snapshotToken);
  assertNoBannedKeys(exported);
  expect(exported.notice).toContain('AI 辅助生成内容');
  expect(new Set(exported.records.map((record) => record.contentOrigin)))
    .toEqual(new Set(['user', 'ai_assisted', 'deterministic']));
});
```

The projector must list every exported scalar explicitly. Body profile exports age, sex label, height, weight, health-scope confirmation, non-training activity, allergens, avoided foods, preferences, and timezone. Goals export goal, optional target weight, effective and target dates. Training exports week/timezone and session date/code/duration as JSON strings. Deterministic targets export business date, policy versions, estimate status, kcal/macros/fiber ranges, and structured unsupported/infeasible codes. Inventory/meal exports user-visible food/dish names, grams, locks, manual-modification flags, totals, target differences, decisions, and reviewed source-version references—not supplier IDs. Photo exports visible AI-assisted candidate names/confidence/state plus confirmation name/grams/status/timestamps, never file metadata. Assistant exports only visible user/assistant messages and marks assistant messages `ai_assisted`. The top-level provenance deduplicates/sorts calculation, nutrition, meal-generation, and reviewed-data version references.

- [x] **Step 2: Write RED tests for the complete deletion state machine**

Cover:

1. stale token rejected before mutation;
2. duplicate private IDs deleted once;
3. `not_found` accepted;
4. second storage file failure leaves full state plus pending marker;
5. exact same retry finishes deletion;
6. same key/different fingerprint rejected;
7. summary reports pending without exposing the command, while export rejects and only the exact delete retry may proceed;
8. database removal failure retains the matching pending aggregate and the retry completes;
9. database-response loss followed by retry returns `account_already_absent`;
10. recreated account has a new snapshot and rejects an old delete command;
11. another user remains untouched.

Use this decisive failure assertion:

```ts
await expect(service.deleteAccount('user-a', command)).rejects.toMatchObject({
  code: 'storage_unavailable'
});
const retained = await repository.readExisting('user-a');
expect(retained).toMatchObject({ accountDeletion: { status: 'pending' } });
expect(retained?.bodyProfiles).toHaveLength(1);
```

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/application/src/personal-data.test.ts packages/application/src/personal-data-export.test.ts
```

Expected: FAIL because the service and public projectors do not exist.

- [x] **Step 4: Implement normalized snapshots and public projectors**

Normalize by destructuring away `accountDeletion`, canonicalize recursively by sorted object keys while preserving array order, then hash UTF-8 canonical JSON with SHA-256. Do not serialize the aggregate wholesale anywhere in the export code. Freeze the notice string as a literal and use exhaustive projector functions for each record category. `exportedAt` is metadata and does not affect the snapshot token. `getPersonalDataSummary` uses `readExisting`, returns zero/null fields for absence, returns the pending marker only as the enum `pending`, and flags pre-v8 oversized aggregates for the documented administrator recovery flow. Oversized legacy data may still be deleted; regular export fails explicitly rather than trimming history.

- [x] **Step 5: Implement the three-phase deletion transition**

Implement exactly:

```ts
// Phase 1: transactionally validate or resume, then persist pending.
const deletion = await repository.transact(userId, (current) => {
  const token = computePersonalDataSnapshotToken(current);
  const fingerprint = requestFingerprint(command);
  // validate token/idempotency or exact pending retry
  const privateFileIds = [...new Set(current.ingredientPhotoVersions
    .map((photo) => photo.expectedPrivateFileId))].sort();
  return {
    nextState: {
      ...current,
      accountDeletion: {
        status: 'pending',
        idempotencyKey: command.idempotencyKey,
        requestFingerprint: fingerprint,
        snapshotToken: token,
        requestedAt: now(),
        privateFileIds
      }
    },
    result: { fingerprint, privateFileIds }
  };
});

// Phase 2: storage calls are outside the transaction.
for (const privateFileId of deletion.privateFileIds) {
  await storage.deletePrivateFile({ privateFileId });
}

// Phase 3: transactionally revalidate marker, then remove the document.
await repository.deleteExisting(userId, (current) => {
  assertMatchingPendingDeletion(current, command, deletion.fingerprint);
  return null;
});
```

Before Phase 1, `readExisting === null` returns `account_already_absent`. If Phase 3 observes a missing document, return `account_already_absent`. Do not catch storage errors; retaining the pending aggregate is the retry mechanism.

- [x] **Step 6: Run focused tests, then all application tests**

Run:

```powershell
pnpm.cmd test -- packages/application/src/personal-data.test.ts packages/application/src/personal-data-export.test.ts
pnpm.cmd test -- packages/application/src
pnpm.cmd --filter @fitness/application typecheck
```

Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add packages/application
git commit -m "feat: add personal data export and account deletion"
```

### Task 4: Strict Planning API Actions and Guarded Runtime Composition

**Files:**
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/cloud-runtime-handler.ts`
- Modify: `cloudfunctions/planning-api/src/cloud-runtime-handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/index.test.ts`
- Create: `tests/e2e/personal-data-workflow.test.ts`

**Interfaces:**
- Consumes: Task 2 guarded repository and Task 3 `PersonalDataService` methods.
- Produces these strict authenticated requests:

```ts
{ action: 'getPersonalDataSummary' }
{ action: 'exportPersonalData'; snapshotToken: string }
{
  action: 'deleteAccount';
  payload: {
    snapshotToken: string;
    idempotencyKey: string;
    confirmation: 'DELETE_MY_ACCOUNT';
  };
}
```

- Produces success kinds `personal_data_summary`, `personal_data_export`, `account_deleted`, and `account_already_absent` plus stable errors `account_deletion_pending`, `personal_data_snapshot_conflict`, and `account_capacity_exceeded`.

- [x] **Step 1: Add RED contract tests**

Assert the three requests parse, every request rejects `userId` and extra keys, export rejects a missing/oversized/non-hex token, delete rejects wrong confirmation or idempotency key, and response schemas recursively reject a banned internal key.

Use `z.string().regex(/^[a-f0-9]{64}$/)` for snapshot tokens and the existing idempotency constraints for delete keys.

- [x] **Step 2: Add RED handler/runtime tests**

Add tests that each action requires trusted context, identity A cannot read/export/delete B, normal planning maps pending deletion to the fixed safe message, stale snapshots map without internals, and cloud composition passes the raw repository only to `createPersonalDataService`:

```ts
expect(await handler({ action: 'getPersonalDataSummary' }, { userId: 'user-a' }))
  .toMatchObject({ success: true, data: { kind: 'personal_data_summary' } });

expect(await handler({ action: 'getCurrentContext' }, { userId: 'pending-user' }))
  .toEqual({
    success: false,
    error: {
      code: 'account_deletion_pending',
      message: '账户正在删除，请重试删除操作或联系隐私支持。'
    }
  });
```

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts cloudfunctions/planning-api/src/cloud-runtime-handler.test.ts cloudfunctions/planning-api/src/index.test.ts
```

Expected: FAIL because new actions, response kinds, error mappings, and composed services are missing.

- [x] **Step 4: Implement contracts and handler routing**

Add all three actions to both `knownActions` and `authenticatedActions`. Extend the handler service type with:

```ts
type PlanningApiService = VersionedPlanningService & Pick<
  PersonalDataService,
  'getPersonalDataSummary' | 'exportPersonalData' | 'deleteAccount'
>;
```

Route each parsed action and validate the final response through `planningApiResponseSchema`. Error responses expose only stable code and fixed Chinese message.

- [x] **Step 5: Compose raw and guarded repositories**

In local and cloud runtimes:

```ts
const rawRepository = new CloudBasePlanningRepository(options.database);
const repository = createAccountDeletionGuardedRepository(rawRepository);
const planning = createIngredientPhotoPlanningService({ repository, /* existing deps */ });
const personalData = createPersonalDataService({
  repository: rawRepository,
  storage,
  now: options.now ?? (() => new Date().toISOString())
});
const service = Object.assign(planning, personalData);
```

For the local runtime, use a deterministic in-memory `PrivatePhotoStorage` that returns `not_found`; this is not production fixture data and only completes local deletion semantics.

- [x] **Step 6: Run API tests and cross-user E2E**

Run:

```powershell
pnpm.cmd test -- packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src tests/e2e/personal-data-workflow.test.ts
pnpm.cmd --filter @fitness/contracts typecheck
pnpm.cmd --filter @fitness/planning-api typecheck
```

Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add packages/contracts cloudfunctions/planning-api tests/e2e/personal-data-workflow.test.ts
git commit -m "feat: expose authenticated personal data actions"
```

### Task 5: Transactional Assistant Summary and Deletion Guard

**Files:**
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/application/src/assistant-conversation.ts`
- Modify: `packages/application/src/assistant-conversation.test.ts`
- Modify: `cloudfunctions/assistant-api/src/runtime-handler.ts`
- Modify: `cloudfunctions/assistant-api/src/runtime-handler.test.ts`
- Modify: `cloudfunctions/assistant-api/src/cloud-runtime-handler.ts`
- Modify: `cloudfunctions/assistant-api/src/cloud-runtime-handler.test.ts`
- Modify: `tests/e2e/assistant-workflow.test.ts`

**Interfaces:**
- Consumes: Task 2 `createAccountDeletionGuardedRepository`.
- Produces:

```ts
export function currentPlanningContextFromState(
  state: PlanningAggregateState
): CurrentPlanningContext;
```

`finalizeTurn` and `finalizeReceivedTurn` derive assistant summary from the same aggregate instance passed to their final repository transaction.

- [x] **Step 1: Add the stale-summary race as a failing regression test**

Construct a repository whose state changes between a pre-transaction planning read and finalization. Assert the saved summary reflects the active training/meal versions and locked dates in the state locked by the final transaction:

```ts
expect(result.summary).toEqual({
  activeWeekStartDate: '2026-08-24',
  trainingPlanVersion: 2,
  mealPlanVersion: 3,
  lockedMealDates: ['2026-08-26'],
  pendingClarification: null
});
```

Add cloud assistant runtime tests that pending deletion rejects conversation reads/writes with `account_deletion_pending` and does not invoke the language provider.

- [x] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/application/src/assistant-conversation.test.ts cloudfunctions/assistant-api/src/runtime-handler.test.ts cloudfunctions/assistant-api/src/cloud-runtime-handler.test.ts tests/e2e/assistant-workflow.test.ts
```

Expected: the race test FAILS because finalization currently obtains context before the transaction; guard composition tests also FAIL.

- [x] **Step 3: Extract the pure context selector and finalize inside one transaction**

Make existing `getCurrentContext(userId)` call `repository.read` followed by `currentPlanningContextFromState`. In assistant finalization:

```ts
return repository.transact(userId, (state) => {
  const context = currentPlanningContextFromState(state);
  const transition = finalizeTurnTransition(
    state,
    context,
    turnId,
    result,
    completedAt,
    false
  );
  if (transition === null) throw new AssistantTurnNotPendingError();
  return transition;
});
```

Do the corresponding nullable transition for `finalizeReceivedTurn`. Remove the pre-transaction `planning.getCurrentContext` calls. Supply the guarded repository to every assistant application service in local and cloud compositions.

- [x] **Step 4: Run assistant and planning regressions**

Run:

```powershell
pnpm.cmd test -- packages/application/src/assistant-conversation.test.ts packages/application/src/versioned-planning.test.ts cloudfunctions/assistant-api/src tests/e2e/assistant-workflow.test.ts
pnpm.cmd --filter @fitness/application typecheck
pnpm.cmd --filter @fitness/assistant-api typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add packages/application cloudfunctions/assistant-api tests/e2e/assistant-workflow.test.ts
git commit -m "fix: finalize assistant summary transactionally"
```

### Task 6: Privacy and Data-rights Mini Program Experience

**Files:**
- Create: `miniprogram/services/release-metadata.ts`
- Create: `miniprogram/services/release-metadata.test.ts`
- Create: `miniprogram/services/local-private-state.ts`
- Create: `miniprogram/services/local-private-state.test.ts`
- Create: `miniprogram/pages/privacy/index.ts`
- Create: `miniprogram/pages/privacy/index.test.ts`
- Create: `miniprogram/pages/privacy/index.json`
- Create: `miniprogram/pages/privacy/index.wxml`
- Create: `miniprogram/pages/privacy/index.wxss`
- Create: `miniprogram/pages/data-rights/index.ts`
- Create: `miniprogram/pages/data-rights/index.test.ts`
- Create: `miniprogram/pages/data-rights/index.json`
- Create: `miniprogram/pages/data-rights/index.wxml`
- Create: `miniprogram/pages/data-rights/index.wxss`
- Modify: `miniprogram/app.json`
- Create: `miniprogram/global.d.ts`
- Create: `miniprogram/pages/planning-setup/index.test.ts`
- Modify: `miniprogram/pages/planning-setup/index.ts`
- Modify: `miniprogram/pages/planning-setup/index.wxml`
- Modify: `miniprogram/pages/planning-preview/index.ts`
- Modify: `miniprogram/pages/planning-preview/index.wxml`
- Modify: `miniprogram/pages/meal-execution/index.ts`
- Modify: `miniprogram/pages/meal-execution/index.wxml`
- Modify: `miniprogram/pages/ingredient-photo/index.ts`
- Modify: `miniprogram/pages/ingredient-photo/index.wxml`
- Modify: `miniprogram/pages/assistant/index.ts`
- Modify: `miniprogram/pages/assistant/index.wxml`
- Modify: `scripts/build-miniprogram.mjs`
- Modify: `miniprogram/build.test.ts`

**Interfaces:**
- Consumes: Task 4 planning API request/response kinds.
- Produces:

```ts
export interface ReleaseMetadata {
  readonly channel: 'development' | 'controlled_beta';
  readonly operatorName: string;
  readonly privacyContact: string;
  readonly privacyNoticeVersion: string;
}

export function clearAllLocalPrivateState(): void;
```

- Development build values are exactly `仅限本地开发，不得发布`, `local-only@invalid.example`, and `local-dev`.
- Controlled-beta values are injected only by `build:miniprogram:release` and validated in Phase 7B.

- [ ] **Step 1: Add RED page, build, and cache-clearing tests**

Test that:

- privacy page renders operator/contact/version, purpose, minimum collection, AI/deterministic-origin explanation, 24-hour photo retention, non-medical limitation, and rights links;
- data-rights load calls `getPersonalDataSummary`;
- export sends the loaded token, can copy strict JSON to clipboard, and can generate/share a local `.json` file from a direct user tap;
- delete button remains disabled until both `删除我的账户` and `DELETE_MY_ACCOUNT` inputs match exactly;
- delete sends a fresh idempotency key and current token;
- both terminal delete results call `wx.clearStorageSync()` before redirecting to planning setup;
- pending/conflict/capacity errors show fixed recovery copy;
- data-rights links to planning setup for versioned correction rather than mutating history in place;
- every existing main page, including planning setup and planning preview, navigates to privacy and data-rights pages;
- build output contains both new pages and no `local-only@invalid.example` when controlled-beta defines are provided.

Use this page test assertion:

```ts
expect(planningCalls.at(-1)).toEqual({
  action: 'deleteAccount',
  payload: {
    snapshotToken: summaryToken,
    idempotencyKey: expect.stringMatching(/^delete-account-/),
    confirmation: 'DELETE_MY_ACCOUNT'
  }
});
expect(wx.clearStorageSync).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- miniprogram/services/release-metadata.test.ts miniprogram/services/local-private-state.test.ts miniprogram/pages/privacy miniprogram/pages/data-rights miniprogram/build.test.ts
```

Expected: FAIL because modules, pages, entries, and build defines do not exist.

- [ ] **Step 3: Implement release metadata and cache clearing**

Declare compile constants in `global.d.ts` and expose a frozen metadata object. `clearAllLocalPrivateState` calls only `wx.clearStorageSync()`, guaranteeing removal of planning, meal workflow, photo, assistant, and future app-local recovery records.

Extend `build-miniprogram.mjs` with `--release-channel=development|controlled_beta`. Development uses the exact local-only values. Controlled beta reads:

```text
FITNESS_PUBLIC_OPERATOR_NAME
FITNESS_PUBLIC_PRIVACY_CONTACT
FITNESS_PRIVACY_NOTICE_VERSION
```

The build script validates only non-empty values here; Phase 7B adds release-grade validation.

- [ ] **Step 4: Implement page controllers and explicit privacy copy**

The data-rights page stores the snapshot token only in page memory. The copy action uses `wx.setClipboardData`. The share action, initiated directly by a user tap, writes UTF-8 JSON to `${wx.env.USER_DATA_PATH}/fitness-personal-data-export.json`, calls `wx.shareFileMessage({ filePath, fileName: 'fitness-personal-data-export.json' })`, and unlinks the local file in the completion callback; unsupported share APIs fall back to clipboard with explicit copy-success text. Never save the export in mini program key/value storage or CloudBase storage. Deletion requires two separate text fields plus a system `wx.showModal` confirmation, shows an irreversible-action warning, disables normal actions while sending, clears storage on both terminal success kinds, then `wx.reLaunch({ url: '/pages/planning-setup/index' })`.

The privacy page must display these exact origin labels:

```text
用户提供：身体档案、目标、训练安排、库存、确认后的照片候选与执行反馈。
AI 辅助：受限助手表述与食材候选；候选必须由用户确认。
确定性估算：热量、训练消耗、营养目标和克数；不是医疗建议。
```

Add `AI 辅助` beside assistant content and ingredient recognition; add `确定性估算，仅供参考` beside target/meal numeric summaries. Do not label stored user text as AI-generated.

- [ ] **Step 5: Run all mini program tests and build**

Run:

```powershell
pnpm.cmd test -- miniprogram
pnpm.cmd typecheck
pnpm.cmd build:miniprogram:local
```

Expected: PASS; `.build/miniprogram/pages/privacy` and `.build/miniprogram/pages/data-rights` each contain JS/JSON/WXML/WXSS.

- [ ] **Step 6: Commit**

```powershell
git add miniprogram scripts/build-miniprogram.mjs
git commit -m "feat: add privacy and personal data pages"
```

### Task 7: Phase 7A Integration Gate and Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/cloudbase/phase-7-personal-data-rights.md`
- Modify: `DEVELOPMENT_PROGRESS.md`
- Test: `tests/e2e/personal-data-workflow.test.ts`
- Test: `tests/e2e/assistant-workflow.test.ts`

**Interfaces:**
- Consumes: all Phase 7A tasks.
- Produces: a code-ready personal-data subsystem and an operator/tester explanation that does not mark Phase 7 complete.

- [ ] **Step 1: Add the final account-lifecycle E2E scenarios**

In a single E2E file, create two authenticated identities. Build user A planning/meal/photo/assistant history, export it, verify every visible numeric record is reproducible from the public values, trigger one storage failure, verify all A normal APIs are blocked, retry deletion, and verify A is absent while B is byte-for-byte unchanged. Recreate A and prove the old command conflicts.

- [ ] **Step 2: Run the Phase 7A gate**

Run:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd dry-run:assistant
pnpm.cmd smoke:api
pnpm.cmd smoke:assistant
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Document exact user and operator behavior**

Document API actions, export exclusions, pending-deletion retry semantics, response-loss behavior, local cache purge, and admin recovery for `account_capacity_exceeded`. In `DEVELOPMENT_PROGRESS.md`, record commands and results under Phase 7 but keep production-data, real deployment, two-account, provider, backup/restore, and device acceptance unchecked.

- [ ] **Step 4: Audit the diff**

Run:

```powershell
git status --short
git diff --stat
git diff --check
rg -n "userId|expectedPrivateFileId|requestFingerprint|idempotencyRecords|accountDeletion" packages/application/src/personal-data-export.ts packages/contracts/src/planning-api.ts miniprogram/pages/data-rights
```

Expected: the export projector contains no emitted banned fields; `.pnpm-store/` remains untouched and untracked.

- [ ] **Step 5: Commit**

```powershell
git add README.md docs/cloudbase/phase-7-personal-data-rights.md DEVELOPMENT_PROGRESS.md tests/e2e
git commit -m "docs: verify phase seven personal data rights"
```
