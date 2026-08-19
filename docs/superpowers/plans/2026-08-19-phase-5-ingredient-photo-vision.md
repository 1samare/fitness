# Phase 5 Ingredient Photo and Vision Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver private ingredient-photo upload, resilient Vision Provider candidates, explicit candidate-and-grams confirmation into versioned inventory, and retryable deletion of registered and orphaned originals.

**Architecture:** Store immutable ingredient-photo revisions in the existing per-user planning aggregate so confirmation and inventory creation commit atomically. Keep raw vision, private storage, and cleanup scheduling behind domain/application ports; expose four strict `planning-api` commands and run deletion through a separate scheduled `photo-cleanup` CloudBase function.

**Tech Stack:** TypeScript 5.9 strict mode, pnpm 9.15, Zod 4, Vitest 3, native WeChat Mini Program APIs, CloudBase Node.js 20 cloud functions, wx-server-sdk, tsup, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-19-phase-5-ingredient-photo-vision-design.md`

## Global Constraints

- Work only on `feat/v1.0`; do not create another branch or Git worktree.
- Do not install dependencies, add frameworks, or load `test_fixture` data when `allowTestFixtures` is false.
- Images are JPEG or PNG, at most 10 MiB, stored only in CloudBase creator-private paths.
- `vision-provider-policy-v1`: 8,000 ms per attempt, one retry only for timeout/transport failure, circuit threshold 3 completed operations, 60,000 ms cooldown, maximum 5 candidates.
- The model never supplies grams, calories, nutrients, internal food IDs, user identity, URLs, or tool names.
- Only an explicit candidate selection plus a positive integer gram value may create an inventory version; confirmation does not generate a meal plan.
- Persist the full expected CloudBase fileID when creating the upload session so an unregistered upload can be deleted.
- Set initial cleanup for 23 hours after session creation; run cleanup every 15 minutes and treat storage `NOT_FOUND` as idempotent success.
- Do not log userId, OpenID, fileID, cloudPath, temporary URL, Base64, prompt text, candidate names, raw provider/storage errors, or local temp paths.
- Use versioned SHA-256 request fingerprints and expected-version checks for every write.
- Preserve `.pnpm-store/` as an unrelated untracked directory and never stage it.

---

### Task 1: Domain Model, Strict Contracts, and Schema-v6 Foundation

**Files:**

- Create: `packages/domain/src/ingredient-photo.ts`
- Create: `packages/domain/src/ingredient-photo.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/versioned-planning.ts`
- Create: `packages/contracts/src/ingredient-photo.ts`
- Create: `packages/contracts/src/ingredient-photo.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.test.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.test.ts`
- Modify: every typed `PlanningAggregateState` fixture reported by `rg -n "PlanningAggregateState" packages cloudfunctions tests`

**Interfaces:**

- Produces `IngredientPhotoVersion`, `NormalizedIngredientCandidate`, `VisionProvider`, `PrivatePhotoStorage`, `latestIngredientPhotoVersions()`, and `deriveNextPhotoCleanupAt()` from `@fitness/domain`.
- Produces strict stored/public photo schemas and the four new `PlanningApiRequest` variants from `@fitness/contracts`.
- Extends `PlanningAggregateState` with `ingredientPhotoVersions` and `nextPhotoCleanupAt`, `LatestPlanningVersions` with `ingredientPhoto`, and idempotency operations with the four photo writes.
- Writes CloudBase schema v6 and structurally migrates v5 by adding only `ingredientPhotoVersions: []` and `nextPhotoCleanupAt: null`.

- [ ] **Step 1: Write failing domain helper tests**

Add `packages/domain/src/ingredient-photo.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { IngredientPhotoVersion } from './ingredient-photo';
import { deriveNextPhotoCleanupAt, latestIngredientPhotoVersions } from './ingredient-photo';

function photo(input: Partial<IngredientPhotoVersion> & Pick<IngredientPhotoVersion, 'id' | 'revision'>): IngredientPhotoVersion {
  return {
    kind: 'ingredient_photo_version',
    id: input.id,
    photoId: input.photoId ?? 'photo-a',
    userId: 'user-a',
    revision: input.revision,
    createdAt: '2026-08-19T00:00:00.000Z',
    uploadCreatedAt: '2026-08-19T00:00:00.000Z',
    deleteDueAt: '2026-08-19T23:00:00.000Z',
    expectedCloudPath: 'ingredient-photos/photo-a/upload-a.jpg',
    expectedPrivateFileId: 'cloud://env.bucket/ingredient-photos/photo-a/upload-a.jpg',
    mediaType: 'image/jpeg',
    workflowStatus: 'awaiting_upload',
    storageStatus: input.storageStatus ?? 'retained',
    candidates: [],
    confirmedCandidateId: null,
    confirmedGrams: null,
    inventoryVersionId: null,
    recognitionFailureCode: null,
    cleanupAttemptCount: 0,
    nextCleanupAt: input.nextCleanupAt ?? '2026-08-19T23:00:00.000Z',
    lastCleanupFailureCode: null,
    deletedAt: null
  };
}

describe('ingredient photo derived state', () => {
  test('keeps only the latest revision for each logical photo', () => {
    expect(latestIngredientPhotoVersions([
      photo({ id: 'v1', revision: 1 }),
      photo({ id: 'v2', revision: 2 }),
      photo({ id: 'b1', photoId: 'photo-b', revision: 1 })
    ]).map((value) => value.id)).toEqual(['v2', 'b1']);
  });

  test('derives the earliest outstanding cleanup time and ignores deleted storage', () => {
    expect(deriveNextPhotoCleanupAt([
      photo({ id: 'a', revision: 1, nextCleanupAt: '2026-08-19T23:15:00.000Z' }),
      photo({ id: 'b', photoId: 'photo-b', revision: 1, nextCleanupAt: '2026-08-19T23:00:00.000Z' }),
      photo({ id: 'c', photoId: 'photo-c', revision: 1, storageStatus: 'deleted', nextCleanupAt: null })
    ])).toBe('2026-08-19T23:00:00.000Z');
  });
});
```

- [ ] **Step 2: Write failing contract tests**

Add `packages/contracts/src/ingredient-photo.test.ts` and extend `planning-api.test.ts` with these concrete assertions:

```ts
import { describe, expect, test } from 'vitest';
import { planningApiRequestSchema, planningApiResponseSchema, visionProviderResponseSchema } from './index';

describe('ingredient photo contracts', () => {
  test('accepts only the four server-owned photo command shapes', () => {
    expect(planningApiRequestSchema.parse({
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'photo-create-001',
        payload: { mediaType: 'image/jpeg' }
      }
    }).action).toBe('createIngredientPhotoUpload');
    expect(planningApiRequestSchema.safeParse({
      action: 'confirmIngredientCandidate',
      payload: {
        expectedVersion: 3,
        idempotencyKey: 'photo-confirm-001',
        payload: {
          photoId: 'photo-a',
          candidateId: 'candidate-a',
          confirmedGrams: 125.5,
          expectedInventoryVersion: 0,
          userId: 'attacker'
        }
      }
    }).success).toBe(false);
  });

  test('rejects nutrition fields and more than five raw vision candidates', () => {
    const candidate = {
      providerCandidateId: 'provider-a',
      name: '鸡胸肉',
      confidence: 0.9,
      foodState: 'raw' as const
    };
    expect(visionProviderResponseSchema.safeParse({
      requestId: 'provider-request-a',
      candidates: [{ ...candidate, grams: 100 }]
    }).success).toBe(false);
    expect(visionProviderResponseSchema.safeParse({
      requestId: 'provider-request-a',
      candidates: Array.from({ length: 6 }, (_, index) => ({
        ...candidate,
        providerCandidateId: `provider-${String(index)}`
      }))
    }).success).toBe(false);
  });

  test('public photo responses reject storage and identity fields', () => {
    const response = {
      success: true,
      data: {
        kind: 'ingredient_photo_recognized',
        photo: {
          photoId: 'photo-a',
          revision: 3,
          workflowStatus: 'recognized',
          storageStatus: 'retained',
          deleteDueAt: '2026-08-19T23:00:00.000Z',
          candidates: [],
          confirmedCandidateId: null,
          inventoryVersionId: null,
          userId: 'user-a'
        }
      }
    };
    expect(planningApiResponseSchema.safeParse(response).success).toBe(false);
  });
});
```

`confirmedGrams: 125.5` must fail because the schema is `z.number().int().positive().max(1_000_000)`.

- [ ] **Step 3: Write failing schema-v5 migration and invariant tests**

In `cloudbase-planning-repository.test.ts`, seed the existing `FakeDatabase` with `{ schemaVersion: 5, state: phase4State }`, then assert:

```ts
test('migrates schema v5 without inventing photo facts', async () => {
  const database = new FakeDatabase();
  const repository = new CloudBasePlanningRepository(database);
  const phase4State = await createPhase4State(new InMemoryPlanningRepository());
  const key = `planning_user_states/${repository.documentIdForUser('user-a')}`;
  const legacyState = structuredClone(phase4State) as unknown as Record<string, unknown>;
  delete legacyState.ingredientPhotoVersions;
  delete legacyState.nextPhotoCleanupAt;
  database.documents.set(key, { schemaVersion: 5, state: legacyState });

  const migrated = await repository.read('user-a');

  expect(migrated.ingredientPhotoVersions).toEqual([]);
  expect(migrated.nextPhotoCleanupAt).toBeNull();
});
```

In `planning-aggregate-invariants.test.ts`, create one valid photo revision, set a wrong derived cleanup pointer, and expect `CorruptPlanningStateError`:

```ts
test('rejects a next photo cleanup pointer that is not derived from latest revisions', async () => {
  const state = await createValidState();
  const corrupt = {
    ...state,
    ingredientPhotoVersions: [validPhotoVersion('user-a')],
    nextPhotoCleanupAt: '2026-08-20T00:00:00.000Z'
  };
  expect(() => assertPlanningAggregateInvariants(corrupt, 'user-a'))
    .toThrow(CorruptPlanningStateError);
});
```

Define `validPhotoVersion(userId)` in that test file with the same complete fields as the `photo()` fixture above and `nextCleanupAt: '2026-08-19T23:00:00.000Z'`.

- [ ] **Step 4: Run the new tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/domain/src/ingredient-photo.test.ts packages/contracts/src/ingredient-photo.test.ts packages/contracts/src/planning-api.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts
```

Expected: FAIL because `ingredient-photo` exports, four request actions, schema-v6 fields, and migration do not exist.

- [ ] **Step 5: Implement the domain model and pure derivation**

Create `packages/domain/src/ingredient-photo.ts` with these exact public shapes:

```ts
export type IngredientPhotoMediaType = 'image/jpeg' | 'image/png';
export type IngredientPhotoWorkflowStatus =
  | 'awaiting_upload'
  | 'uploaded'
  | 'recognized'
  | 'recognition_failed'
  | 'confirmed';
export type IngredientPhotoStorageStatus =
  | 'retained'
  | 'cleanup_pending'
  | 'cleanup_failed'
  | 'deleted';
export type PhotoCleanupFailureCode = 'storage_unavailable';

export interface VisionCandidate {
  readonly providerCandidateId: string;
  readonly name: string;
  readonly confidence: number;
  readonly foodState: 'raw' | 'cooked' | 'dry' | 'unknown';
}

export interface VisionProvider {
  recognize(input: { readonly privateFileId: string; readonly requestId: string }): Promise<{
    readonly providerRequestId: string;
    readonly candidates: readonly VisionCandidate[];
  }>;
}

export interface PrivatePhotoStorage {
  inspectPrivateFile(input: { readonly privateFileId: string }): Promise<{
    readonly mediaType: IngredientPhotoMediaType;
    readonly sizeBytes: number;
  }>;
  deletePrivateFile(input: { readonly privateFileId: string }): Promise<'deleted' | 'not_found'>;
}

export interface NormalizedIngredientCandidate {
  readonly id: string;
  readonly foodId: string;
  readonly nutritionSnapshotId: string;
  readonly canonicalNameZh: string;
  readonly confidence: number;
  readonly foodState: 'raw' | 'cooked' | 'dry';
}

export interface IngredientPhotoVersion {
  readonly kind: 'ingredient_photo_version';
  readonly id: string;
  readonly photoId: string;
  readonly userId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly uploadCreatedAt: string;
  readonly deleteDueAt: string;
  readonly expectedCloudPath: string;
  readonly expectedPrivateFileId: string;
  readonly mediaType: IngredientPhotoMediaType;
  readonly workflowStatus: IngredientPhotoWorkflowStatus;
  readonly storageStatus: IngredientPhotoStorageStatus;
  readonly candidates: readonly NormalizedIngredientCandidate[];
  readonly confirmedCandidateId: string | null;
  readonly confirmedGrams: number | null;
  readonly inventoryVersionId: string | null;
  readonly recognitionFailureCode: 'no_supported_candidate' | null;
  readonly cleanupAttemptCount: number;
  readonly nextCleanupAt: string | null;
  readonly lastCleanupFailureCode: PhotoCleanupFailureCode | null;
  readonly deletedAt: string | null;
}
```

Implement `latestIngredientPhotoVersions()` with first-seen logical photo order and highest revision replacement. Implement `deriveNextPhotoCleanupAt()` as the lexicographic minimum non-null `nextCleanupAt` from latest revisions whose `storageStatus !== 'deleted'`.

- [ ] **Step 6: Implement strict stored/public schemas and request/response unions**

Create `packages/contracts/src/ingredient-photo.ts` and export:

```ts
export const ingredientPhotoMediaTypeSchema = z.enum(['image/jpeg', 'image/png']);
export const visionCandidateSchema = z.object({
  providerCandidateId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(40),
  confidence: z.number().finite().min(0).max(1),
  foodState: z.enum(['raw', 'cooked', 'dry', 'unknown'])
}).strict();
export const visionProviderResponseSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  candidates: z.array(visionCandidateSchema).max(5),
  estimatedCostUnits: z.number().finite().nonnegative().optional()
}).strict();
```

Also export strict stored `IngredientPhotoVersion` and public photo/candidate schemas. The public photo schema contains exactly `photoId`, `revision`, `workflowStatus`, `storageStatus`, `deleteDueAt`, `candidates`, `confirmedCandidateId`, and `inventoryVersionId`.

Extend `planningApiRequestSchema` with:

```ts
createIngredientPhotoUpload: writeEnvelopeSchema(z.object({ mediaType: ingredientPhotoMediaTypeSchema }).strict())
registerIngredientPhotoUpload: writeEnvelopeSchema(z.object({
  photoId: z.string().min(1).max(200),
  privateFileId: z.string().min(10).max(1_024).regex(/^cloud:\/\//)
}).strict())
recognizeIngredientPhoto: writeEnvelopeSchema(z.object({ photoId: z.string().min(1).max(200) }).strict())
confirmIngredientCandidate: writeEnvelopeSchema(z.object({
  photoId: z.string().min(1).max(200),
  candidateId: z.string().min(1).max(200),
  confirmedGrams: z.number().int().positive().max(1_000_000),
  expectedInventoryVersion: z.number().int().nonnegative()
}).strict())
```

Add successful kinds `ingredient_photo_upload_created`, `ingredient_photo_upload_registered`, `ingredient_photo_recognized`, and `ingredient_candidate_confirmed`. Only the create result adds `cloudPath`; the confirm result contains public photo plus the existing public inventory schema. Add `ingredientPhoto` to `latestVersions` and `ingredientPhoto: PublicIngredientPhoto | null` to current context. Add `storage_unavailable` and `candidate_confirmation_required` to the standard public error enum.

- [ ] **Step 7: Implement schema-v6 migration and invariants**

Update empty states and typed fixtures with:

```ts
ingredientPhotoVersions: [],
nextPhotoCleanupAt: null
```

Change `StoredPlanningDocument['schemaVersion']` and `encodeDocument()` to `6`. Accept versions 2–6 in `decodeDocument()` and migrate version 5 by adding only the two fields above. Extend `planningAggregateStateSchema` and `IdempotencyRecord` for the four photo operations.

In `assertPlanningAggregateInvariants`, validate owner, unique IDs, contiguous per-photo revisions, immutable storage identity fields, legal workflow/storage transitions, candidate identity, confirmation references, confirmed inventory contents, and exact `deriveNextPhotoCleanupAt(state.ingredientPhotoVersions) === state.nextPhotoCleanupAt`.

- [ ] **Step 8: Run targeted tests and root typecheck**

Run:

```powershell
pnpm.cmd exec vitest run packages/domain/src/ingredient-photo.test.ts packages/contracts/src/ingredient-photo.test.ts packages/contracts/src/planning-api.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts
pnpm.cmd typecheck
```

Expected: all targeted tests PASS and all strict workspace typechecks exit 0.

- [ ] **Step 9: Commit the schema foundation**

```powershell
git add packages/domain packages/contracts packages/persistence packages/application cloudfunctions tests
git commit -m "feat: define ingredient photo workflow"
```

Before committing, verify `git status --short` does not stage `.pnpm-store/`.

---

### Task 2: Resilient Vision and Private Storage Adapters

**Files:**

- Create: `packages/providers/src/vision-provider-policy.ts`
- Create: `packages/providers/src/resilient-vision-provider.ts`
- Create: `packages/providers/src/resilient-vision-provider.test.ts`
- Create: `packages/providers/src/cloudbase-function-vision-backend.ts`
- Create: `packages/providers/src/cloudbase-function-vision-backend.test.ts`
- Create: `packages/providers/src/cloudbase-private-photo-storage.ts`
- Create: `packages/providers/src/cloudbase-private-photo-storage.test.ts`
- Modify: `packages/providers/src/index.ts`

**Interfaces:**

- Consumes `VisionProvider`, `PrivatePhotoStorage`, and `visionProviderResponseSchema` from Task 1.
- Produces `VISION_PROVIDER_POLICY_V1`, `ResilientVisionProvider`, `CloudBaseFunctionVisionBackend`, `CloudBasePrivatePhotoStorage`, `UnavailableVisionProvider`, and the sanitized `ProviderObservation` contract.

- [ ] **Step 1: Write failing resilience tests**

Create `resilient-vision-provider.test.ts` using fake timers and a backend sequence:

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ResilientVisionProvider } from './resilient-vision-provider';

afterEach(() => { vi.useRealTimers(); });

describe('ResilientVisionProvider', () => {
  test('times out, retries once, and returns the second valid response', async () => {
    vi.useFakeTimers();
    const backend = {
      recognizePrivateFile: vi.fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({
          requestId: 'provider-request-2',
          candidates: [{
            providerCandidateId: 'candidate-1',
            name: '鸡胸肉',
            confidence: 0.9,
            foodState: 'raw'
          }]
        })
    };
    const provider = new ResilientVisionProvider({
      providerName: 'fixture-vision',
      backend,
      nowMs: () => Date.now(),
      observe: () => undefined
    });

    const resultPromise = provider.recognize({
      privateFileId: 'cloud://private/photo.jpg',
      requestId: 'vision-request-1'
    });
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(resultPromise).resolves.toMatchObject({ providerRequestId: 'provider-request-2' });
    expect(backend.recognizePrivateFile).toHaveBeenCalledTimes(2);
  });

  test('opens after three failed operations and emits no sensitive fields', async () => {
    let nowMs = 0;
    const observations: unknown[] = [];
    const backend = { recognizePrivateFile: vi.fn().mockRejectedValue(new Error('fileID=secret')) };
    const provider = new ResilientVisionProvider({
      providerName: 'fixture-vision',
      backend,
      nowMs: () => nowMs,
      observe: (event) => { observations.push(event); }
    });
    for (let operation = 0; operation < 3; operation += 1) {
      await expect(provider.recognize({
        privateFileId: 'cloud://secret/photo.jpg',
        requestId: `request-${String(operation)}`
      })).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    await expect(provider.recognize({
      privateFileId: 'cloud://secret/photo.jpg',
      requestId: 'request-open'
    })).rejects.toMatchObject({ reason: 'circuit_open' });
    expect(JSON.stringify(observations)).not.toContain('cloud://secret');
    expect(JSON.stringify(observations)).not.toContain('fileID=secret');
    nowMs = 60_000;
  });
});
```

- [ ] **Step 2: Write failing backend and storage tests**

Create tests that assert exact nested-function input, strict response validation, JPEG/PNG signature checks, 10 MiB rejection, and `NOT_FOUND` deletion:

```ts
test('calls only the configured CloudBase function with a private fileID', async () => {
  const callFunction = vi.fn().mockResolvedValue({ result: { requestId: 'r1', candidates: [] } });
  const backend = new CloudBaseFunctionVisionBackend(callFunction, 'fitness-vision');
  await expect(backend.recognizePrivateFile('cloud://env.bucket/photo.jpg'))
    .resolves.toEqual({ requestId: 'r1', candidates: [] });
  expect(callFunction).toHaveBeenCalledWith({
    name: 'fitness-vision',
    data: { privateFileId: 'cloud://env.bucket/photo.jpg' }
  });
});

test('sniffs JPEG bytes and treats missing deletion as success', async () => {
  const client = {
    downloadFile: vi.fn().mockResolvedValue({ fileContent: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) }),
    deleteFile: vi.fn().mockResolvedValue({
      requestId: 'delete-r1',
      fileList: [{ fileID: 'cloud://env.bucket/photo.jpg', code: 'STORAGE_FILE_NONEXIST' }]
    })
  };
  const storage = new CloudBasePrivatePhotoStorage(client);
  await expect(storage.inspectPrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
    .resolves.toEqual({ mediaType: 'image/jpeg', sizeBytes: 4 });
  await expect(storage.deletePrivateFile({ privateFileId: 'cloud://env.bucket/photo.jpg' }))
    .resolves.toBe('not_found');
});
```

- [ ] **Step 3: Run Provider tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/providers/src/resilient-vision-provider.test.ts packages/providers/src/cloudbase-function-vision-backend.test.ts packages/providers/src/cloudbase-private-photo-storage.test.ts
```

Expected: FAIL because all three adapters are missing.

- [ ] **Step 4: Implement the named resilience policy and wrapper**

Create `vision-provider-policy.ts`:

```ts
export const VISION_PROVIDER_POLICY_V1 = Object.freeze({
  policyVersion: 'vision-provider-policy-v1' as const,
  timeoutMs: 8_000,
  retryCount: 1 as const,
  failureThreshold: 3,
  cooldownMs: 60_000,
  maximumCandidates: 5,
  maximumFileBytes: 10 * 1024 * 1024
});
```

Implement `ResilientVisionProvider` so each operation has at most two attempts, only timeout/transport failures retry, schema errors stop immediately, operation failure increments the circuit counter once, success resets it, and one half-open call is allowed after cooldown. Parse backend output with `visionProviderResponseSchema`; map it to `providerRequestId` and candidates. `ProviderObservation` contains only `provider`, `requestId`, `attempt`, `latencyMs`, `status`, `stableErrorCode?`, and `estimatedCostUnits?`.

- [ ] **Step 5: Implement CloudBase backend and private storage**

`CloudBaseFunctionVisionBackend` validates function names with `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/` and passes only `{ privateFileId }`.

`CloudBasePrivatePhotoStorage` accepts an injected client:

```ts
export interface CloudBasePrivateFileClient {
  downloadFile(input: { readonly fileID: string }): Promise<unknown>;
  deleteFile(input: { readonly fileList: readonly string[] }): Promise<unknown>;
}
```

Inspect a `Uint8Array`, reject files above `VISION_PROVIDER_POLICY_V1.maximumFileBytes`, accept JPEG magic `ff d8 ff` and PNG magic `89 50 4e 47 0d 0a 1a 0a`, and throw a stable `{ code: 'storage_unavailable' }` error for missing/invalid bytes. Parse each deletion result; return `deleted` for `SUCCESS`, `not_found` for the documented missing-object codes, and throw the stable error otherwise. Never include the raw result in an error message.

Implement `UnavailableVisionProvider.recognize()` as an immediate stable `{ code: 'provider_unavailable', reason: 'vision_provider_unavailable' }` rejection.

- [ ] **Step 6: Run Provider tests and package typecheck**

Run:

```powershell
pnpm.cmd exec vitest run packages/providers/src/resilient-vision-provider.test.ts packages/providers/src/cloudbase-function-vision-backend.test.ts packages/providers/src/cloudbase-private-photo-storage.test.ts
pnpm.cmd --filter @fitness/providers typecheck
```

Expected: all Provider tests PASS and provider strict typecheck exits 0.

- [ ] **Step 7: Commit the Provider boundary**

```powershell
git add packages/providers
git commit -m "feat: add resilient vision provider"
```

---

### Task 3: Upload Session, Registration, and Recognition Commands

**Files:**

- Create: `packages/application/src/ingredient-photo.ts`
- Create: `packages/application/src/ingredient-photo.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/application/src/meal-plan-generation.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Create: `packages/application/src/versioned-planning.test.ts`

**Interfaces:**

- Consumes the versioned repository, `NutritionProvider`, `VisionProvider`, and `PrivatePhotoStorage` ports.
- Produces `createIngredientPhotoCommands()` and `createIngredientPhotoPlanningService()`.
- Performs storage and Provider I/O outside repository transactions, then rechecks logical-photo revision and status inside the transaction.
- Does not mutate inventory, nutrition targets, meal plans, recalculation jobs, or outbox records during create, register, or recognize.

- [ ] **Step 1: Write failing upload and registration tests**

Add deterministic clock/ID dependencies and test the exact expected storage identity:

```ts
const commands = createIngredientPhotoCommands({
  repository,
  nutrition,
  vision,
  storage,
  now: () => '2026-08-19T00:00:00.000Z',
  nextId: createSequenceId(['photo-a', 'upload-a', 'photo-version-1']),
  storageFileIdPrefix: 'cloud://env.bucket/',
  allowTestFixtures: true
});

test('creates a private upload session with cleanup due before 24 hours', async () => {
  const result = await commands.createIngredientPhotoUpload('user-a', {
    expectedVersion: 0,
    idempotencyKey: 'photo-create-001',
    payload: { mediaType: 'image/jpeg' }
  });
  expect(result).toMatchObject({
    cloudPath: 'ingredient-photos/photo-a/upload-a.jpg',
    photo: {
      photoId: 'photo-a',
      revision: 1,
      workflowStatus: 'awaiting_upload',
      deleteDueAt: '2026-08-19T23:00:00.000Z'
    }
  });
  const state = await repository.read('user-a');
  expect(state.ingredientPhotoVersions[0]?.expectedPrivateFileId)
    .toBe('cloud://env.bucket/ingredient-photos/photo-a/upload-a.jpg');
});

test('registers only the exact private fileID after byte inspection', async () => {
  await createUpload(commands);
  await expect(commands.registerIngredientPhotoUpload('user-a', {
    expectedVersion: 1,
    idempotencyKey: 'photo-register-001',
    payload: {
      photoId: 'photo-a',
      privateFileId: 'cloud://env.bucket/ingredient-photos/photo-a/upload-a.jpg'
    }
  })).resolves.toMatchObject({ photo: { workflowStatus: 'uploaded', revision: 2 } });
  expect(storage.inspectPrivateFile).toHaveBeenCalledWith({
    privateFileId: 'cloud://env.bucket/ingredient-photos/photo-a/upload-a.jpg'
  });
});
```

Also test rejection of a different fileID, type/signature mismatch, oversized bytes, stale photo version, changed status during inspection, and replay of the same idempotency key without a second storage inspection.

- [ ] **Step 2: Write failing recognition and no-side-effect tests**

Use a raw Provider result with one resolvable candidate, one unknown-state candidate, and one unresolved name:

```ts
test('maps reviewed candidates and leaves every planning output unchanged', async () => {
  await createAndRegisterPhoto(commands);
  const before = await repository.read('user-a');

  const result = await commands.recognizeIngredientPhoto('user-a', {
    expectedVersion: 2,
    idempotencyKey: 'photo-recognize-001',
    payload: { photoId: 'photo-a' }
  });

  expect(result.photo.candidates).toEqual([{
    id: expect.any(String),
    foodId: 'food-chicken-breast',
    nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
    canonicalNameZh: '鸡胸肉',
    confidence: 0.92,
    foodState: 'raw'
  }]);
  const after = await repository.read('user-a');
  expect(after.inventoryVersions).toEqual(before.inventoryVersions);
  expect(after.dailyNutritionTargetVersions).toEqual(before.dailyNutritionTargetVersions);
  expect(after.mealPlanVersions).toEqual(before.mealPlanVersions);
  expect(after.recalculationJobs).toEqual(before.recalculationJobs);
  expect(after.outboxEvents).toEqual(before.outboxEvents);
});
```

Test stable candidate ordering by confidence descending then canonical food identity, duplicate-food collapse to the highest confidence, maximum five normalized candidates, `recognition_failed/no_supported_candidate`, one idempotent replay, Provider unavailability, and a concurrent photo-revision change between Provider completion and transaction commit.

- [ ] **Step 3: Run command tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/ingredient-photo.test.ts packages/application/src/versioned-planning.test.ts
```

Expected: FAIL because the photo command service and current-context photo derivation do not exist.

- [ ] **Step 4: Implement deterministic upload identities and application errors**

Define the dependency seam and error classes in `ingredient-photo.ts`:

```ts
export interface IngredientPhotoCommandDependencies {
  readonly repository: PlanningRepository;
  readonly nutrition: NutritionProvider;
  readonly vision: VisionProvider;
  readonly storage: PrivatePhotoStorage;
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
  readonly storageFileIdPrefix: string;
  readonly allowTestFixtures: boolean;
}

export class IngredientPhotoNotFoundError extends Error {
  readonly code = 'ingredient_photo_not_found';
}

export class PrivatePhotoOwnershipError extends Error {
  readonly code = 'private_photo_ownership_mismatch';
}
```

Normalize `storageFileIdPrefix` to one trailing slash, reject non-`cloud://` prefixes, choose `.jpg` or `.png` only from the validated media type, and build the path from server-generated IDs only. Use `addHours(now, 23)` for `deleteDueAt` and `nextCleanupAt`. Fingerprint each strict command envelope with the existing SHA-256 canonical fingerprint helper.

- [ ] **Step 5: Implement create and register with transaction rechecks**

For create, compare `expectedVersion` with the number of latest logical photos, append revision 1, record the idempotency result, and derive `nextPhotoCleanupAt` in the same transaction.

For register:

1. Read and validate the latest logical photo and exact `expectedPrivateFileId`.
2. Call `inspectPrivateFile()` outside the transaction.
3. Require inspected media type to equal the upload-session media type.
4. Re-read inside `transact()`, require the same revision and `awaiting_upload` status, append revision 2 with `uploaded`, and store the idempotency result.

Never trust a client-supplied cloud path and never persist returned storage metadata beyond validated media type and size policy.

- [ ] **Step 6: Implement recognition normalization and guarded commit**

Call `vision.recognize()` outside the transaction with the persisted private fileID. For each raw candidate:

```ts
const resolution = await nutrition.resolveCanonicalName(raw.name);
if (resolution === null || raw.foodState === 'unknown') return null;
const snapshot = await nutrition.getSnapshot(resolution.nutritionSnapshotId);
if (
  snapshot.foodId !== resolution.foodId
  || (
    snapshot.qualityStatus !== 'reviewed'
    && !(dependencies.allowTestFixtures && snapshot.qualityStatus === 'test_fixture')
  )
) return null;
return {
  id: stableCandidateId(photo.photoId, resolution.foodId, resolution.nutritionSnapshotId, raw.foodState),
  foodId: resolution.foodId,
  nutritionSnapshotId: resolution.nutritionSnapshotId,
  canonicalNameZh: resolution.canonicalNameZh,
  confidence: raw.confidence,
  foodState: raw.foodState
};
```

Deduplicate by `foodId + nutritionSnapshotId + foodState`, sort deterministically, take five, then transact only if the latest revision still equals the pre-I/O revision and status remains `uploaded` or `recognition_failed`. Append either `recognized` or `recognition_failed`; never store raw names or Provider request payloads.

- [ ] **Step 7: Expose the composed planning service and current context**

Implement:

```ts
export function createIngredientPhotoPlanningService(
  dependencies: MealPlanRecalculationServiceDependencies & IngredientPhotoCommandDependencies
) {
  return {
    ...createMealPlanRecalculationService(dependencies),
    ...createIngredientPhotoCommands(dependencies)
  };
}
```

Extend `getCurrentContext()` to return the most recently created latest logical photo, including a `deleted` storage status when only the original object is gone, plus `latestVersions.ingredientPhoto`; preserve every existing phase-4 field.

- [ ] **Step 8: Run application tests and typecheck**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/ingredient-photo.test.ts packages/application/src/versioned-planning.test.ts packages/application/src/meal-plan-generation.test.ts
pnpm.cmd --filter @fitness/application typecheck
```

Expected: all application tests PASS and application strict typecheck exits 0.

- [ ] **Step 9: Commit recognition commands**

```powershell
git add packages/application
git commit -m "feat: recognize private ingredient photos"
```

---

### Task 4: Explicit Confirmation and Atomic Inventory Versioning

**Files:**

- Modify: `packages/application/src/ingredient-photo.ts`
- Modify: `packages/application/src/ingredient-photo.test.ts`
- Modify: `packages/application/src/versioned-planning.ts`
- Modify: `packages/application/src/versioned-planning.test.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.test.ts`

**Interfaces:**

- Consumes a recognized candidate, positive integer grams, exact photo version, and exact inventory version.
- Atomically appends one photo revision and one `InventoryVersion` in the same repository transaction.
- Marks storage `cleanup_pending` immediately, but does not synchronously delete within the confirmation transaction.

- [ ] **Step 1: Write failing explicit-confirmation tests**

```ts
test('atomically confirms a selected candidate and creates one inventory version', async () => {
  await createRegisterAndRecognize(commands);
  const result = await commands.confirmIngredientCandidate('user-a', {
    expectedVersion: 3,
    idempotencyKey: 'photo-confirm-001',
    payload: {
      photoId: 'photo-a',
      candidateId: recognizedCandidateId,
      confirmedGrams: 125,
      expectedInventoryVersion: 0
    }
  });

  expect(result.photo).toMatchObject({
    workflowStatus: 'confirmed',
    storageStatus: 'cleanup_pending',
    confirmedCandidateId: recognizedCandidateId,
    inventoryVersionId: result.inventory.id
  });
  expect(result.inventory.items).toEqual([{
    foodId: 'food-chicken-breast',
    nutritionSnapshotId: 'snapshot-chicken-breast-2026-08',
    availableGrams: 125
  }]);
  const state = await repository.read('user-a');
  expect(state.ingredientPhotoVersions).toHaveLength(4);
  expect(state.inventoryVersions).toHaveLength(1);
});
```

Add failures for absent selection, candidate from another photo, zero/fractional grams at the contract boundary, stale photo version, stale inventory version, cross-user access, nutrition snapshot identity drift, and repository failure. Assert repository failure leaves both version collections unchanged.

- [ ] **Step 2: Write failing idempotency and planning-staleness tests**

Confirm the same request twice and assert exactly one inventory/photo revision pair. Seed an existing meal plan based on the prior inventory, confirm a candidate, and assert that the existing meal becomes stale through existing context derivation while no new meal plan, nutrition target, recalculation job, or outbox event is created.

- [ ] **Step 3: Run confirmation tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/ingredient-photo.test.ts packages/application/src/versioned-planning.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts
```

Expected: FAIL because confirmation and its cross-version invariants are not implemented.

- [ ] **Step 4: Implement snapshot revalidation and atomic confirmation**

Before the transaction, reload the candidate's nutrition snapshot and require exact `foodId`, `nutritionSnapshotId`, and an allowed `qualityStatus` (`reviewed`, or `test_fixture` only in explicit local mode). Inside the transaction, recheck photo revision/status and current inventory version, then merge grams by `(foodId, nutritionSnapshotId)`:

```ts
const nextItems = [...currentInventoryItems];
const existingIndex = nextItems.findIndex((item) =>
  item.foodId === selected.foodId &&
  item.nutritionSnapshotId === selected.nutritionSnapshotId
);
if (existingIndex >= 0) {
  const existing = nextItems[existingIndex];
  if (existing === undefined) throw new Error('inventory_item_missing');
  nextItems[existingIndex] = {
    ...existing,
    availableGrams: existing.availableGrams + input.payload.confirmedGrams
  };
} else {
  nextItems.push({
    foodId: selected.foodId,
    nutritionSnapshotId: selected.nutritionSnapshotId,
    availableGrams: input.payload.confirmedGrams
  });
}
nextItems.sort((left, right) =>
  `${left.foodId}:${left.nutritionSnapshotId}`.localeCompare(`${right.foodId}:${right.nutritionSnapshotId}`)
);
```

Append the inventory using the existing version/fingerprint conventions. Append the photo revision with `confirmed`, selected candidate ID, grams, inventory version ID, `cleanup_pending`, and `nextCleanupAt: now.toISOString()`. Record one combined idempotency result in the same transaction.

- [ ] **Step 5: Enforce confirmation invariants**

Require every confirmed photo to reference a candidate in its own immutable candidate list and an inventory version owned by the same user. Recompute the expected inventory delta from the prior inventory and selected candidate; reject a state where the linked inventory does not contain that exact delta. Require legal transitions `recognized -> confirmed` only and prohibit any later confirmation rewrite.

- [ ] **Step 6: Run confirmation suite and typecheck**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/ingredient-photo.test.ts packages/application/src/versioned-planning.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts
pnpm.cmd --filter @fitness/application typecheck
pnpm.cmd --filter @fitness/persistence typecheck
```

Expected: all tests PASS and both package typechecks exit 0.

- [ ] **Step 7: Commit atomic confirmation**

```powershell
git add packages/application packages/persistence
git commit -m "feat: confirm ingredient candidates"
```

---

### Task 5: Planning API and Runtime Composition

**Files:**

- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.ts`
- Modify: `cloudfunctions/planning-api/src/runtime-handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/index.ts`
- Modify: `cloudfunctions/planning-api/package.json`
- Modify: `cloudbaserc.json`
- Modify: `data/nutrition-fixtures/src/index.ts`
- Modify: `data/nutrition-fixtures/src/index.test.ts`

**Interfaces:**

- Adds the four photo actions to authenticated API dispatch.
- Composes real private storage with a configured nested CloudBase vision function in cloud mode.
- Enables deterministic vision fixtures only in the existing explicit local runtime mode; a missing production vision configuration fails closed.

- [ ] **Step 1: Write failing handler authorization, mapping, and redaction tests**

```ts
test.each([
  'createIngredientPhotoUpload',
  'registerIngredientPhotoUpload',
  'recognizeIngredientPhoto',
  'confirmIngredientCandidate'
])('%s requires trusted CloudBase identity', async (action) => {
  const response = await handler(requestFor(action), { auth: null });
  expect(response).toEqual({ success: false, error: { code: 'unauthenticated' } });
});

test('maps a recognized photo without leaking private storage identity', async () => {
  const response = await authenticatedRecognize(handler);
  expect(response).toMatchObject({
    success: true,
    data: { kind: 'ingredient_photo_recognized' }
  });
  const serialized = JSON.stringify(response);
  expect(serialized).not.toContain('user-a');
  expect(serialized).not.toContain('cloud://');
  expect(serialized).not.toContain('ingredient-photos/');
});
```

Also test that client `userId`, URL, cloud path, nutrition, and gram fields are rejected by strict schemas, and that `ingredient_photo_not_found`, ownership mismatch, storage unavailability, Provider unavailability, stale version, and candidate-confirmation errors map to stable public errors without raw messages.

- [ ] **Step 2: Write failing runtime composition tests**

Test these exact modes:

```ts
test('cloud mode fails closed without a configured vision function', async () => {
  const runtime = createRuntimePlanningHandler({
    runtimeMode: 'cloud',
    database,
    cloud,
    environment: { CLOUDBASE_STORAGE_FILE_ID_PREFIX: 'cloud://env.bucket/' }
  });
  const response = await runtime(recognizeRequest, trustedUserContext);
  expect(response).toMatchObject({
    success: false,
    error: { code: 'provider_unavailable', reason: 'vision_provider_unavailable' }
  });
});

test('fixture vision is available only in explicit local mode', async () => {
  const runtime = createRuntimePlanningHandler({
    runtimeMode: 'local',
    environment: { CLOUDBASE_STORAGE_FILE_ID_PREFIX: 'cloud://local.bucket/' },
    storage: fakeStorage
  });
  await expect(runLocalPhotoTimeline(runtime)).resolves.toMatchObject({
    success: true,
    data: { kind: 'ingredient_photo_recognized' }
  });
});
```

Assert cloud mode constructs `CloudBaseFunctionVisionBackend` only from validated `FITNESS_VISION_FUNCTION_NAME`, private storage only from the server SDK, and create-upload rejects a missing/invalid `CLOUDBASE_STORAGE_FILE_ID_PREFIX`.

- [ ] **Step 3: Run planning-api tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts data/nutrition-fixtures/src/index.test.ts
```

Expected: FAIL because handler dispatch and runtime Provider/storage composition are absent.

- [ ] **Step 4: Add authenticated handler dispatch and public mapping**

Extend the service type to `ReturnType<typeof createIngredientPhotoPlanningService>`, add the actions to the known/authenticated sets, and dispatch each parsed envelope with the trusted server-derived user ID. Implement `toPublicIngredientPhoto()` as a field-by-field mapper:

```ts
return {
  photoId: photo.photoId,
  revision: photo.revision,
  workflowStatus: photo.workflowStatus,
  storageStatus: photo.storageStatus,
  deleteDueAt: photo.deleteDueAt,
  candidates: photo.candidates.map(toPublicIngredientCandidate),
  confirmedCandidateId: photo.confirmedCandidateId,
  inventoryVersionId: photo.inventoryVersionId
};
```

Never spread the stored photo into a response. Reuse the existing inventory public mapper for confirmation.

- [ ] **Step 5: Compose fixture and cloud runtime modes**

In fixture mode, use the versioned local nutrition fixture plus a deterministic raw vision fixture that returns only names/confidence/food state. In cloud mode:

```ts
const vision = environment.FITNESS_VISION_FUNCTION_NAME === undefined
  ? new UnavailableVisionProvider()
  : new ResilientVisionProvider({
      providerName: 'cloudbase-ai-vision',
      backend: new CloudBaseFunctionVisionBackend(
        (input) => cloud.callFunction(input),
        environment.FITNESS_VISION_FUNCTION_NAME
      ),
      nowMs: () => Date.now(),
      observe: observeProvider
    });
const storage = new CloudBasePrivatePhotoStorage(cloud);
```

Only emit sanitized Provider observations. Set the planning-api CloudBase timeout high enough for two 8-second Provider attempts plus application overhead; use 25 seconds.

- [ ] **Step 6: Run API tests, contract tests, and typecheck**

Run:

```powershell
pnpm.cmd exec vitest run cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/runtime-handler.test.ts data/nutrition-fixtures/src/index.test.ts packages/contracts/src/planning-api.test.ts
pnpm.cmd --filter @fitness/planning-api typecheck
```

Expected: all tests PASS and planning-api strict typecheck exits 0.

- [ ] **Step 7: Commit the API surface**

```powershell
git add cloudfunctions/planning-api packages/providers data/nutrition-fixtures cloudbaserc.json
git commit -m "feat: expose ingredient photo commands"
```

---

### Task 6: Retryable Cleanup, Due-User Query, and CloudBase Deployment Boundaries

**Files:**

- Create: `packages/application/src/ingredient-photo-cleanup.ts`
- Create: `packages/application/src/ingredient-photo-cleanup.test.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/persistence/src/cloudbase-photo-cleanup-targets.ts`
- Create: `packages/persistence/src/cloudbase-photo-cleanup-targets.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `cloudfunctions/photo-cleanup/src/handler.ts`
- Create: `cloudfunctions/photo-cleanup/src/handler.test.ts`
- Create: `cloudfunctions/photo-cleanup/src/runtime-handler.ts`
- Create: `cloudfunctions/photo-cleanup/src/runtime-handler.test.ts`
- Create: `cloudfunctions/photo-cleanup/src/index.ts`
- Create: `cloudfunctions/photo-cleanup/package.json`
- Create: `cloudfunctions/photo-cleanup/tsconfig.json`
- Create: `cloudfunctions/photo-cleanup/tsup.config.ts`
- Modify: `cloudbaserc.json`
- Modify: `cloudbase/function.rules.json`
- Create: `cloudbase/storage.rules.json`
- Modify: `scripts/build-cloudfunction-deploy.mjs`
- Create: `tests/e2e/cloudfunction-deploy-artifact.test.ts`
- Modify: `package.json`

**Interfaces:**

- Queries due aggregate documents through a persistence adapter, yielding trusted user IDs to application cleanup.
- Deletes a retained/pending/failed private object outside the transaction, then records `deleted` or schedules one 15-minute retry after a stable failure.
- Runs on `0 */15 * * * * *` and never permits client invocation.

- [ ] **Step 1: Write failing application cleanup tests**

```ts
test('treats an already missing object as successful idempotent deletion', async () => {
  storage.deletePrivateFile.mockResolvedValue('not_found');
  const result = await cleanup.cleanupDuePhoto('user-a', 'photo-a', '2026-08-19T23:00:00.000Z');
  expect(result).toEqual({ status: 'deleted' });
  const latest = latestPhoto(await repository.read('user-a'), 'photo-a');
  expect(latest).toMatchObject({
    storageStatus: 'deleted',
    nextCleanupAt: null,
    deletedAt: '2026-08-19T23:00:00.000Z'
  });
});

test('schedules one stable retry without exposing the storage error', async () => {
  storage.deletePrivateFile.mockRejectedValue(new Error('cloud://secret raw-provider-error'));
  await expect(cleanup.cleanupDuePhoto('user-a', 'photo-a', now)).resolves.toEqual({
    status: 'retry_scheduled',
    retryAt: '2026-08-19T23:15:00.000Z'
  });
  expect(latestPhoto(await repository.read('user-a'), 'photo-a')).toMatchObject({
    storageStatus: 'cleanup_failed',
    cleanupAttemptCount: 1,
    lastCleanupFailureCode: 'storage_unavailable',
    nextCleanupAt: '2026-08-19T23:15:00.000Z'
  });
});
```

Also cover an unregistered `awaiting_upload` photo at +23h, immediate confirmed cleanup, not-yet-due no-op, replay after deleted, and a concurrent new revision while deletion is in flight. The concurrent case may append a deletion result only when storage identity is unchanged; otherwise it must re-evaluate the latest revision.

- [ ] **Step 2: Write failing due-query and handler isolation tests**

Define:

```ts
export interface PhotoCleanupTargetRepository {
  listDueTargets(input: {
    readonly before: string;
    readonly limit: number;
  }): Promise<readonly { readonly userId: string; readonly photoId: string }[]>;
}
```

Seed CloudBase documents with earlier, equal, later, null, and deleted cleanup states. Assert the persistence adapter queries `state.nextPhotoCleanupAt <= before`, decodes schema v6, derives latest photo revisions, and returns at most 50 due targets without leaking document IDs to the handler response.

Test the cleanup handler continues across per-target failures:

```ts
expect(await handler({ now: '2026-08-19T23:00:00.000Z' })).toEqual({
  processed: 3,
  deleted: 1,
  retryScheduled: 1,
  skipped: 1,
  failed: 0
});
```

Captured logs may contain only batch counts, stable error codes, and latency; assert serialized logs omit user IDs, photo IDs, fileIDs, cloud paths, and raw errors.

- [ ] **Step 3: Write failing deployment-boundary tests**

审查纠错：默认 `cloudbaserc.json` 必须 trigger-free；以下 trigger 只允许出现在独立 `cloudbaserc.photo-cleanup-timer.json`，并在外部门禁通过后激活：

```json
{
  "triggers": [
    { "name": "photo-cleanup-every-15-minutes", "type": "timer", "config": "0 */15 * * * * *" }
  ]
}
```

Assert `cloudbase/function.rules.json` denies direct invocation of `photo-cleanup`; `cloudbase/storage.rules.json` uses official flat top-level `read`/`write` keys with the exact expression `auth != null && /^ingredient-photos\\//.test(resource.path) == true && resource.openid == auth.openid`, rejects a `rules` wrapper and `resource.creator`; and both deploy bundles exclude workspace links, source maps, fixtures, and unrelated functions.

- [ ] **Step 4: Run cleanup tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/ingredient-photo-cleanup.test.ts packages/persistence/src/cloudbase-photo-cleanup-targets.test.ts cloudfunctions/photo-cleanup/src/handler.test.ts cloudfunctions/photo-cleanup/src/runtime-handler.test.ts tests/e2e/cloudfunction-deploy-artifact.test.ts
```

Expected: FAIL because cleanup service, function, query adapter, and deployment boundaries are absent.

- [ ] **Step 5: Implement cleanup state transitions**

Implement `createIngredientPhotoCleanupService()` with `cleanupDuePhoto(userId, photoId, nowIso)`. Read the latest due revision, derive an internal idempotency key `photo-cleanup:<photoId>:<revision>:<nextCleanupAt>`, delete the persisted expected private fileID outside the transaction, and inside the transaction recheck due time, revision lineage, storage identity, and storage status. On `deleted`/`not_found`, append a revision with `storageStatus: 'deleted'`, `nextCleanupAt: null`, and `deletedAt`. On a stable deletion failure, append `cleanup_failed`, increment attempts, set only `storage_unavailable`, and schedule exactly `nowIso + 15 minutes`. The source revision is the internal expected version; replaying the derived key returns the recorded result without another write.

Recompute `state.nextPhotoCleanupAt` after every cleanup transition and make an already-deleted target a no-op.

- [ ] **Step 6: Implement CloudBase due-target persistence**

Use an injected minimal database query interface. Query only documents whose derived aggregate pointer is due, decode them through the existing schema-v6 decoder, then select due latest logical photos in application-neutral persistence code. Return trusted `state.userId` rather than document IDs. Cap a batch at 50 and sort by `nextCleanupAt`, then user ID, then photo ID for repeatable processing.

- [ ] **Step 7: Implement the scheduled cloud function**

The runtime constructs `CloudBasePlanningRepository`, `CloudBasePhotoCleanupTargetRepository`, `CloudBasePrivatePhotoStorage`, and the cleanup service from server SDK clients. The handler processes one bounded batch sequentially so storage pressure is controlled, isolates each target, and returns counts only. Reject caller-supplied target IDs; the production entry point accepts no semantic input other than an optional test-injected clock unavailable in the deployed entry.

- [ ] **Step 8: Add storage/function rules and build support**

Create official flat creator-private storage rules, add the deny rule for `photo-cleanup`, keep root `cloudbaserc.json` trigger-free, and put the 15-minute timer only in root `cloudbaserc.photo-cleanup-timer.json` for post-validation activation. Refactor `build-cloudfunction-deploy.mjs` to package an explicit allowlist `['planning-api', 'photo-cleanup']`, each into its own `.build/cloudfunctions/<name>` directory. Add the cleanup dry-run while preserving the existing API dry-run:

```json
{
  "dry-run:api": "pnpm --filter @fitness/planning-api build && pnpm --filter @fitness/planning-api dry-run",
  "dry-run:photo-cleanup": "pnpm --filter @fitness/photo-cleanup build && pnpm --filter @fitness/photo-cleanup dry-run"
}
```

Keep the prior API dry-run behavior compatible and update the artifact checker to inspect each allowlisted bundle.

- [ ] **Step 9: Run cleanup, deployment, and type checks**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/ingredient-photo-cleanup.test.ts packages/persistence/src/cloudbase-photo-cleanup-targets.test.ts cloudfunctions/photo-cleanup/src/handler.test.ts cloudfunctions/photo-cleanup/src/runtime-handler.test.ts tests/e2e/cloudfunction-deploy-artifact.test.ts
pnpm.cmd --filter @fitness/application typecheck
pnpm.cmd --filter @fitness/persistence typecheck
pnpm.cmd --filter @fitness/photo-cleanup typecheck
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
```

Expected: all tests/typechecks PASS and both dry runs produce isolated deployable artifacts.

- [ ] **Step 10: Commit cleanup infrastructure**

```powershell
git add packages/application packages/persistence cloudfunctions/photo-cleanup cloudbase scripts package.json pnpm-lock.yaml
git commit -m "feat: clean private ingredient photos"
```

Verify no dependency was added and `pnpm-lock.yaml` changed only if workspace package registration requires it.

---

### Task 7: Native Mini Program Confirmation Flow

**Files:**

- Create: `miniprogram/pages/ingredient-photo/ingredient-photo-form.ts`
- Create: `miniprogram/pages/ingredient-photo/ingredient-photo-form.test.ts`
- Create: `miniprogram/pages/ingredient-photo/pending-command.ts`
- Create: `miniprogram/pages/ingredient-photo/pending-command.test.ts`
- Create: `miniprogram/pages/ingredient-photo/view-model.ts`
- Create: `miniprogram/pages/ingredient-photo/view-model.test.ts`
- Create: `miniprogram/pages/ingredient-photo/index.ts`
- Create: `miniprogram/pages/ingredient-photo/index.json`
- Create: `miniprogram/pages/ingredient-photo/index.wxml`
- Create: `miniprogram/pages/ingredient-photo/index.wxss`
- Modify: `miniprogram/pages/meal-execution/index.wxml`
- Modify: `miniprogram/pages/meal-execution/index.ts`
- Modify: `miniprogram/services/planning-api.ts`
- Modify: `miniprogram/app.json`
- Modify: `scripts/build-miniprogram.mjs`
- Modify: `miniprogram/app.runtime.test.ts`
- Create: `miniprogram/build.test.ts`

**Interfaces:**

- Presents upload, registration, recognition, explicit candidate choice, integer grams, and confirmation as distinct user actions.
- Persists only a redacted pending command with idempotency key/action/public IDs; never stores or logs the local temporary path or private fileID.
- Keeps manual ingredient entry visible as the recovery path on every upload/recognition failure.

- [ ] **Step 1: Write failing pure form and view-model tests**

```ts
test('requires an explicit candidate and a positive integer gram value', () => {
  expect(buildConfirmIngredientCommand({
    photoId: 'photo-a',
    photoRevision: 3,
    selectedCandidateId: null,
    gramsText: '125',
    expectedInventoryVersion: 0,
    idempotencyKey: 'photo-confirm-001'
  })).toEqual({ ok: false, reason: 'candidate_required' });
  expect(buildConfirmIngredientCommand({
    photoId: 'photo-a',
    photoRevision: 3,
    selectedCandidateId: 'candidate-a',
    gramsText: '125.5',
    expectedInventoryVersion: 0,
    idempotencyKey: 'photo-confirm-001'
  })).toEqual({ ok: false, reason: 'grams_must_be_positive_integer' });
});

test('does not preselect the highest-confidence candidate', () => {
  expect(createIngredientPhotoViewModel(recognizedPhoto).selectedCandidateId).toBeNull();
});
```

Test pending-command serialization contains no temp path, fileID, cloud path, candidate name, or grams before explicit confirmation. Test response-loss recovery reuses the same idempotency key.

- [ ] **Step 2: Write failing build-manifest and navigation tests**

Assert `pages/ingredient-photo/index` is registered in `app.json`, included in the mini-program build entry allowlist, and reachable from meal execution. Assert the service timeout is at least 20 seconds so the API's bounded Provider retry can return a controlled response.

- [ ] **Step 3: Run mini-program tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run miniprogram/pages/ingredient-photo/ingredient-photo-form.test.ts miniprogram/pages/ingredient-photo/pending-command.test.ts miniprogram/pages/ingredient-photo/view-model.test.ts miniprogram/app.runtime.test.ts miniprogram/build.test.ts
```

Expected: FAIL because the page, form builders, and build entry do not exist.

- [ ] **Step 4: Implement strict command builders and redacted recovery**

Create pure builders for the four API actions. Parse grams using `/^[1-9][0-9]*$/` and `Number.isSafeInteger`. Store pending state in this exact shape:

```ts
export interface PendingIngredientPhotoCommand {
  readonly action:
    | 'createIngredientPhotoUpload'
    | 'registerIngredientPhotoUpload'
    | 'recognizeIngredientPhoto'
    | 'confirmIngredientCandidate';
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly photoId: string | null;
  readonly candidateId: string | null;
  readonly expectedInventoryVersion: number | null;
}
```

The upload-only private fileID remains in page memory just long enough to call register and is cleared immediately afterward; it is never passed to logging helpers or local storage.

- [ ] **Step 5: Implement the page state machine and accessible UI**

Use `wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] })`, call create-upload, `wx.cloud.uploadFile({ cloudPath, filePath })`, register returned `fileID`, then recognize. Validate local size before upload as early feedback while retaining server-side byte inspection as authority.

Render candidate radio controls with canonical Chinese name, food state, and an explicit “估算识别结果，请确认” label. Do not auto-select. Show the gram input only after a radio choice, label it as an estimate supplied by the user, and show a separate confirmation button. On failure, keep a visible “手动录入食材” navigation action and do not imply nutrition or meal recalculation already occurred.

- [ ] **Step 6: Add build entry, navigation, and timeout**

Register the page and styles, add a meal-execution entry action, add the new TypeScript page to the explicit esbuild entry map/assets list, and set the planning-api client timeout to `20_000` ms. Preserve all existing pages and build outputs.

- [ ] **Step 7: Run mini-program tests and build**

Run:

```powershell
pnpm.cmd exec vitest run miniprogram/pages/ingredient-photo/ingredient-photo-form.test.ts miniprogram/pages/ingredient-photo/pending-command.test.ts miniprogram/pages/ingredient-photo/view-model.test.ts miniprogram/app.runtime.test.ts miniprogram/build.test.ts
pnpm.cmd build:miniprogram
```

Expected: all tests PASS and the built app contains the ingredient-photo page without source-only fixtures.

- [ ] **Step 8: Commit the mini-program flow**

```powershell
git add miniprogram scripts/build-miniprogram.mjs
git commit -m "feat: add ingredient photo confirmation flow"
```

---

### Task 8: End-to-End Evidence, Documentation, and Phase Exit

**Files:**

- Create: `tests/e2e/ingredient-photo-workflow.test.ts`
- Modify: `tests/smoke/planning-api.smoke.test.ts`
- Modify: `README.md`
- Create: `docs/cloudbase/phase-5-ingredient-photo-deployment.md`
- Modify: `DEVELOPMENT_PROGRESS.md`

**Interfaces:**

- Verifies the complete private photo lifecycle through API handlers using only fakes/fixtures.
- Records exact deploy prerequisites and distinguishes automated evidence from external CloudBase/device verification.
- Marks phase 5 completed only after every required local command passes in a fresh run.

- [ ] **Step 1: Write the failing end-to-end lifecycle test**

Drive these commands through the authenticated planning-api handler with one in-memory repository, fake private storage, fixture vision, and reviewed nutrition snapshot:

```ts
const created = await call('createIngredientPhotoUpload', createEnvelope);
await fakeStorage.put(created.data.cloudPath, jpegBytes);
const registered = await call('registerIngredientPhotoUpload', registerEnvelope(created));
const recognized = await call('recognizeIngredientPhoto', recognizeEnvelope(registered));
expect(await repository.read('user-a')).toMatchObject({ inventoryVersions: [] });
const confirmed = await call('confirmIngredientCandidate', confirmEnvelope(recognized, 125));
await cleanupHandler({ now: confirmed.data.photo.deleteDueAt });

expect(confirmed.data.inventory.items[0]?.availableGrams).toBe(125);
expect(latestPhoto(await repository.read('user-a')).storageStatus).toBe('deleted');
```

Repeat recognition and confirmation requests to prove idempotency, attempt cross-user registration/confirmation, simulate upload response loss, simulate cleanup `NOT_FOUND`, and assert all prior body/goal/training/nutrition/meal historical versions remain unchanged.

- [ ] **Step 2: Run the end-to-end test and verify RED if integration is incomplete**

Run:

```powershell
pnpm.cmd exec vitest run tests/e2e/ingredient-photo-workflow.test.ts
```

Expected before final integration fixes: FAIL only at concrete wiring or lifecycle gaps revealed by the test. Fix those gaps at their owning layer, adding a focused regression assertion before modifying implementation.

- [ ] **Step 3: Document deployment and honest verification boundaries**

Update `README.md` with the implemented photo flow and environment variable names only. In `docs/cloudbase/phase-5-ingredient-photo-deployment.md`, document:

- creator-private storage rule deployment;
- `CLOUDBASE_STORAGE_FILE_ID_PREFIX` format;
- `FITNESS_VISION_FUNCTION_NAME` configuration and nested-function permission;
- 25-second planning-api timeout and 15-minute cleanup timer;
- real-provider contract requirement that output contains names/confidence/food state only;
- manual-entry fallback;
- deploy/smoke commands and rollback to the previous function artifacts;
- external checks that cannot be claimed locally: real Hunyuan response, CloudBase rule enforcement with two accounts, timer delivery, WeChat IDE, and physical-device camera/upload behavior.

Do not claim that the real provider, deployed rules, timer, IDE, or physical device have been verified unless that evidence is actually obtained.

- [ ] **Step 4: Update the dynamic progress record with actual results**

Only after the fresh verification run, mark phase 5 completed in `DEVELOPMENT_PROGRESS.md`. Check each acceptance item supported by passing evidence, paste the exact commands and pass counts, list the external verification items above as remaining deployment checks, and set phase 6 as next. If any required local command fails, keep phase 5 “进行中” and record the failure instead.

- [ ] **Step 5: Run the complete fresh verification suite**

Run in this order:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd smoke:api
git diff --check
rg -n --hidden --glob "!.git/**" --glob "!.pnpm-store/**" "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|SECRET_ACCESS_KEY|cloud://[^'\" ]+|tmpfile|tempFilePath" .
git status --short
git diff --stat
```

Expected: lint, all strict typechecks, all tests, both builds, both dry-runs, smoke test, and diff check exit 0. Review any `rg` hits as code/test fixtures and ensure no real fileID, key, user photo, or local temp path is committed. Confirm `.pnpm-store/` remains untracked and unstaged.

- [ ] **Step 6: Review requirements against evidence**

Check this coverage map before completion:

| Requirement | Primary evidence |
| --- | --- |
| Private server-generated upload path and ownership | Tasks 3, 5, 6, 8 |
| JPEG/PNG and 10 MiB server validation | Task 2 |
| Provider timeout/retry/circuit/schema/redaction | Tasks 2 and 5 |
| Candidate-only vision; no grams/nutrition invention | Tasks 1, 3, 7 |
| Explicit candidate and positive integer grams | Tasks 1, 4, 7 |
| Atomic immutable inventory confirmation | Tasks 1 and 4 |
| No early inventory/nutrition/meal mutation | Tasks 3 and 8 |
| Registered and orphan cleanup before 24h target | Tasks 3 and 6 |
| Cleanup retry and idempotent missing-object behavior | Tasks 2, 6, 8 |
| Cross-user isolation and public response redaction | Tasks 3, 5, 8 |
| Manual-entry fallback and native-page build | Task 7 |
| Deployment and external verification boundaries | Task 8 |

- [ ] **Step 7: Commit phase evidence**

```powershell
git add tests README.md docs/cloudbase DEVELOPMENT_PROGRESS.md
git commit -m "test: complete ingredient photo workflow"
```

Before committing, inspect `git diff --cached --stat` and `git diff --cached`; do not stage `.pnpm-store/` or unrelated user changes.

---

## Plan Self-Review Gate

Before starting Task 1 implementation:

- [ ] Confirm every phase-5 acceptance item in `DEVELOPMENT_PROGRESS.md` maps to at least one task in the coverage table.
- [ ] Search this plan for generic drafting markers and replace them with concrete commands, values, and expected behavior.
- [ ] Verify every referenced package/script/file name against the current repository tree.
- [ ] Verify domain, contracts, application, Provider, persistence, API, cleanup, and mini-program types agree on field names and status values.
- [ ] Confirm no step requires a new dependency, branch, worktree, live paid API, public URL, client-trusted user ID, or database access from the agent/provider layer.
- [ ] Confirm every implementation task starts with a failing test and ends with targeted verification.
- [ ] Confirm phase completion remains conditional on fresh lint, typecheck, test, build, dry-run, smoke, diff, and sensitive-data checks.
