# Phase 7B Production Data and Release Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cloud fixture-unavailable meal planning with a fail-closed reviewed-dataset adapter and add reproducible release, dataset, capacity, privacy, secret, artifact, and configuration gates.

**Architecture:** Store one explicitly selected, licensed, immutable reviewed-data graph in `planning_reviewed_datasets`; a strict provider validates metadata, checksum, license window, record quality, and all graph edges before exposing the existing nutrition/recipe/menu interfaces. Release scripts reuse pure validators so their behavior is tested in temporary fixtures, while evidence is written only to ignored `.build/release-evidence` and never contains credentials or health data.

**Tech Stack:** TypeScript 5.9 strict mode, Zod, Vitest, Node.js 20 ESM scripts, CloudBase document database, esbuild, CloudBase CLI `@cloudbase/cli@3.7.2` for the later deployment plan.

**Spec:** `docs/superpowers/specs/2026-08-20-phase-7-cloud-integration-controlled-beta-design.md`

## Global Constraints

- Work only on `feat/v1.0`; do not create a branch or worktree.
- Do not add a runtime framework. Do not use live paid APIs in ordinary tests.
- Production requires exact `FITNESS_REVIEWED_DATASET_ID`; there is no default dataset and no fixture fallback.
- Every production nutrition snapshot, recipe, menu, and catalog record has `qualityStatus: 'reviewed'` and a closed reference graph.
- License/source/cache/display metadata, overall expiry, SHA-256 checksum, dataset version, and review time are mandatory.
- Runtime external nutrition acquisition is forbidden; acquisition/import is an offline release operation.
- A candidate dataset is validated before upload; the active dataset ID changes only after validation evidence succeeds, leaving the prior dataset active on failure.
- `release:check`, `release:dataset`, `release:capacity`, and `release:preflight` must be behaviorally tested with temporary fixtures.
- Release diagnostics print only field name plus present/missing/version/status, never the underlying value.
- Release evidence lives only under ignored `.build/release-evidence`; it is anonymized and contains no health profile, free text, image/file ID, token, OpenID, AppID, environment ID, secret, or provider response body.
- The deploy artifact allowlist remains exactly `planning-api`, `assistant-api`, and `photo-cleanup`, each with only `index.js` and `package.json`.
- Every implementation task follows RED → GREEN → focused regression → commit.

---

### Task 1: Strict Reviewed Planning Dataset Contract and Offline Validator

**Files:**
- Create: `packages/contracts/src/reviewed-planning-dataset.ts`
- Create: `packages/contracts/src/reviewed-planning-dataset.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/providers/src/reviewed-planning-dataset-validator.ts`
- Create: `packages/providers/src/reviewed-planning-dataset-validator.test.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `scripts/lib/reviewed-dataset-evidence.mjs`
- Create: `scripts/validate-reviewed-dataset.mjs`
- Create: `scripts/validate-reviewed-dataset.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `NutritionDataSnapshot`, `RecipeTemplateVersion`, `DailyMenuTemplateVersion`, and `DailyMenuCatalogVersion` shapes.
- Produces:

```ts
export const reviewedPlanningDatasetV1Schema: z.ZodType<ReviewedPlanningDatasetV1>;

export interface ReviewedPlanningDatasetV1 {
  readonly schemaVersion: 'reviewed-planning-dataset-v1';
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly approvalStatus: 'approved';
  readonly qualityStatus: 'reviewed';
  readonly activatedAt: string;
  readonly reviewedAt: string;
  readonly validUntil: string;
  readonly checksumSha256: string;
  readonly sourceReferences: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly version: string;
    readonly authorizationEvidenceRef: string;
    readonly cacheAllowed: true;
    readonly displayAllowed: true;
    readonly authorizationValidUntil: string | null;
    readonly noExpiryBasis: string | null;
    readonly exitDisposition: 'retain_historical_only';
  }[];
  readonly nutritionSnapshots: readonly NutritionDataSnapshot[];
  readonly recipeTemplates: readonly RecipeTemplateVersion[];
  readonly dailyMenus: readonly DailyMenuTemplateVersion[];
  readonly menuCatalog: DailyMenuCatalogVersion;
}

// Exported by @fitness/providers; the schema and inferred type are exported by @fitness/contracts.
export function canonicalReviewedDatasetPayload(
  dataset: Omit<ReviewedPlanningDatasetV1, 'checksumSha256'>
): string;
export function validateReviewedPlanningDataset(
  value: unknown,
  now: string
): ReviewedPlanningDatasetV1;
```

The checksum is lowercase 64-character SHA-256 over canonical sorted-key JSON with `checksumSha256` omitted.

- [x] **Step 1: Add RED schema and graph tests**

Create a minimal fully closed approved dataset containing exactly seven daily menus and assert acceptance. Mutate it one case at a time and assert rejection for unknown keys, missing `approved`, `test_fixture`, activation after review, missing/invalid authorization evidence, neither-or-both authorization expiry/no-expiry basis, non-historical exit disposition, missing source reference, duplicate record IDs, checksum mismatch, expired `validUntil`, non-true cache/display permission, recipe→snapshot mismatch, menu→recipe mismatch, catalog→menu mismatch, not-exactly-seven menus, mismatched dataset/source metadata, and an unreferenced dangling record.

```ts
it('rejects a menu edge to a missing recipe', () => {
  const candidate = validDataset();
  candidate.dailyMenus[0].meals[0].recipeTemplateVersionId = 'missing-recipe';
  expect(() => validateReviewedPlanningDataset(withChecksum(candidate), NOW))
    .toThrowError(InvalidReviewedPlanningDatasetError);
});
```

The closed graph is exact: every catalog menu exists, every stored menu is catalog-reachable, every menu recipe exists, every stored recipe is menu-reachable, every recipe ingredient snapshot exists and matches its `foodId`, and every stored snapshot is recipe-reachable.

- [x] **Step 2: Add RED script behavior tests**

Invoke the script through an exported `validateDatasetFile({ inputPath, evidenceDirectory, now })`. A valid file writes `.build/release-evidence/dataset-validation.json` containing only schema version, dataset ID hash, dataset version, checksum, record counts, validation timestamp, and `status: 'passed'`. Invalid input exits non-zero and does not replace prior passing evidence.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/contracts/src/reviewed-planning-dataset.test.ts scripts/validate-reviewed-dataset.test.ts
```

Expected: FAIL because the schema, canonicalizer, validator, and script do not exist.

- [x] **Step 4: Implement the contract, canonical checksum, and closed graph**

Use strict Zod objects and existing domain-level scalar bounds. Canonical JSON sorts object keys recursively and preserves array order. Check ISO times lexically only after Zod date-time parsing; require `reviewedAt <= now < validUntil`. Check each record `datasetVersion` matches the envelope and each `sourceId` exists in `sourceReferences`.

- [x] **Step 5: Implement the offline evidence writer and package command**

Keep the strict schema/inferred DTO in `@fitness/contracts`, and keep checksum/graph/license validation in the Node-only `@fitness/providers` validator. Add:

```json
{
  "scripts": {
    "release:dataset": "pnpm --filter @fitness/providers build && node scripts/validate-reviewed-dataset.mjs"
  }
}
```

The executable reads only `FITNESS_REVIEWED_DATASET_FILE` and optional `FITNESS_RELEASE_NOW`; it never uploads or modifies an active dataset. Write evidence atomically via a temporary sibling file followed by rename.

- [x] **Step 6: Run tests and contract typecheck**

Run:

```powershell
pnpm.cmd test -- packages/contracts/src/reviewed-planning-dataset.test.ts scripts/validate-reviewed-dataset.test.ts
pnpm.cmd --filter @fitness/contracts typecheck
```

Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add packages/contracts scripts package.json
git commit -m "feat: validate reviewed planning datasets"
```

### Task 2: Fail-closed CloudBase Reviewed-data Provider

**Files:**
- Create: `packages/providers/src/cloudbase-reviewed-planning-data-provider.ts`
- Create: `packages/providers/src/cloudbase-reviewed-planning-data-provider.test.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `cloudfunctions/planning-api/src/cloud-runtime-handler.ts`
- Modify: `cloudfunctions/planning-api/src/cloud-runtime-handler.test.ts`
- Modify: `cloudfunctions/assistant-api/src/cloud-runtime-handler.ts`
- Modify: `cloudfunctions/assistant-api/src/cloud-runtime-handler.test.ts`
- Modify: `cloudfunctions/planning-api/src/wx-database-adapter.ts`
- Modify: `cloudfunctions/assistant-api/src/wx-database-adapter.ts`

**Interfaces:**
- Consumes: Task 1 `validateReviewedPlanningDataset` and the existing three Provider interfaces.
- Produces:

```ts
export interface ReviewedPlanningDatasetSource {
  read(datasetId: string): Promise<unknown | null>;
}

export interface CloudBaseReviewedPlanningDataProviderOptions {
  readonly datasetId: string;
  readonly source: ReviewedPlanningDatasetSource;
  readonly now: () => string;
  readonly nowMs: () => number;
  readonly cacheTtlMs: number;
  readonly loadTimeoutMs: number;
}

export class CloudBaseReviewedPlanningDataProvider
  implements NutritionProvider, RecipeTemplateProvider, DailyMenuCatalogProvider {
  getSnapshot(snapshotId: string): Promise<NutritionDataSnapshot>;
  resolveCanonicalName(name: string): Promise<FoodResolution | null>;
  getByVersionId(versionId: string): Promise<RecipeTemplateVersion>;
  getActiveCatalog(): Promise<DailyMenuCatalogVersion>;
  getMenuByVersionId(versionId: string): Promise<DailyMenuTemplateVersion>;
}
```

- `RuntimeEnvironment.FITNESS_REVIEWED_DATASET_ID` is required and has no fallback.
- Cache TTL is fixed at 60 seconds in production composition.

- [x] **Step 1: Write RED provider tests**

Test concurrent cold calls share one in-flight source promise, one source read within TTL, immutable clones on every return, refresh after TTL, a 2,000 ms read timeout, fail-closed missing document/database failure, invalid graph/checksum/license on cold load, failed candidates not cached, and license expiry on every request even while the cached object is warm:

```ts
it('fails when a warm cached dataset crosses its license boundary', async () => {
  const provider = createProvider({ now: () => clock.iso, nowMs: () => clock.ms });
  await provider.getActiveCatalog();
  clock.advanceTo('2026-09-01T00:00:00.000Z');
  await expect(provider.getActiveCatalog()).rejects.toMatchObject({
    code: 'reviewed_dataset_unavailable'
  });
});
```

Also assert `resolveCanonicalName` canonicalizes the input using the current existing food-name rules and returns null for ambiguous/missing aliases rather than guessing.

- [x] **Step 2: Add RED cloud runtime composition tests**

Assert cloud handler creation rejects blank/missing `FITNESS_REVIEWED_DATASET_ID`, never constructs unavailable or fixture providers, reads collection `planning_reviewed_datasets` with exactly the configured document ID, and both planning and assistant compositions use the same provider policy. Provider errors map to existing `provider_unavailable` without exposing dataset contents.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- packages/providers/src/cloudbase-reviewed-planning-data-provider.test.ts cloudfunctions/planning-api/src/cloud-runtime-handler.test.ts cloudfunctions/assistant-api/src/cloud-runtime-handler.test.ts
```

Expected: FAIL because the CloudBase provider and environment setting do not exist.

- [x] **Step 4: Implement validated cache lookup**

Every public method calls `loadValidDataset()`. A warm cache still checks `now() < validUntil`; after 60 seconds it re-reads and revalidates checksum/license/graph. Clone returned records with `structuredClone`. Convert any source/read/schema error to `ReviewedDatasetUnavailableError` with stable code `reviewed_dataset_unavailable`; do not retain a failed candidate in cache.

- [x] **Step 5: Replace unavailable cloud providers**

Create a source adapter that calls:

```ts
database.collection('planning_reviewed_datasets').doc(datasetId).get()
```

and returns `result.data ?? null`. Compose one provider instance as:

```ts
const reviewed = new CloudBaseReviewedPlanningDataProvider({
  datasetId: requireReviewedDatasetId(options.environment?.FITNESS_REVIEWED_DATASET_ID),
  source: createCloudBaseReviewedDatasetSource(options.database),
  now: options.now ?? (() => new Date().toISOString()),
  nowMs: () => Date.now(),
  cacheTtlMs: 60_000,
  loadTimeoutMs: 2_000
});
const providers = {
  nutrition: reviewed,
  recipes: reviewed,
  menus: reviewed,
  allowTestFixtures: false
};
```

Remove `unavailableNutritionProvider`, `unavailableRecipeProvider`, and `unavailableMenuProvider` from cloud runtime code. Local/smoke fixtures remain isolated in local runtime only.

- [x] **Step 6: Run provider, cloud runtime, and meal regressions**

Run:

```powershell
pnpm.cmd test -- packages/providers/src cloudfunctions/planning-api/src/cloud-runtime-handler.test.ts cloudfunctions/assistant-api/src/cloud-runtime-handler.test.ts packages/application/src/meal-plan-generation.test.ts packages/application/src/meal-plan-editing.test.ts
pnpm.cmd --filter @fitness/providers typecheck
pnpm.cmd --filter @fitness/planning-api typecheck
pnpm.cmd --filter @fitness/assistant-api typecheck
```

Expected: PASS.

- [x] **Step 7: Commit**

```powershell
git add packages/providers cloudfunctions/planning-api cloudfunctions/assistant-api
git commit -m "feat: load production reviewed planning data"
```

### Task 3: Release Metadata, Configuration, Artifact, and Secret Preflight

**Files:**
- Create: `scripts/lib/release-config.mjs`
- Create: `scripts/lib/release-config.test.ts`
- Create: `scripts/release-preflight.mjs`
- Create: `scripts/release-preflight.test.ts`
- Create: `scripts/scan-release-artifacts.mjs`
- Create: `scripts/scan-release-artifacts.test.ts`
- Modify: `scripts/build-miniprogram.mjs`
- Modify: `scripts/build-cloudfunction-deploy.mjs`
- Modify: `miniprogram/build.test.ts`
- Modify: `tests/e2e/cloudfunction-deploy-artifact.test.ts`
- Modify: `package.json`
- Create: `docs/release/phase-7-release-manifest.json`

**Interfaces:**
- Consumes: Phase 7A release metadata defines, Task 1 dataset evidence, existing CloudBase configs, and ignored `project.private.config.json`.
- Produces:

```json
{
  "cloudbaseCliVersion": "3.7.2",
  "nodeRuntime": "Nodejs20.19",
  "functions": ["photo-cleanup", "planning-api", "assistant-api"],
  "reviewedDatasetCollection": "planning_reviewed_datasets",
  "userStateCollection": "planning_user_states",
  "requiredServerConfigNames": [
    "CLOUDBASE_STORAGE_FILE_ID_PREFIX",
    "FITNESS_VISION_FUNCTION_NAME",
    "CLOUDBASE_ENV_ID",
    "FITNESS_LLM_PROVIDER_ID",
    "FITNESS_LLM_MODEL",
    "FITNESS_REVIEWED_DATASET_ID"
  ]
}
```

- `runReleasePreflight({ repositoryRoot, env, runCliVersion })` returns a structured pass/fail report; the CLI formatter emits only names and states.

- [x] **Step 1: Add RED pure preflight tests**

Build temporary repositories and assert failures for tourist AppID, absent/empty private AppID, absent target environment selection, local-only operator/contact/version, missing or stale dataset evidence, wrong CLI version, missing server config name, wrong CloudBase runtime/handler/timeout/install setting, timer config drift beyond the one expected trigger, and untracked release input.

Assert output never contains seeded sentinels:

```ts
expect(reportText).not.toContain('wx-real-appid-sentinel');
expect(reportText).not.toContain('env-secret-sentinel');
expect(reportText).not.toContain('privacy-contact-sentinel');
expect(reportText).toContain('AppID: present');
expect(reportText).toContain('CloudBase CLI: version 3.7.2');
```

Required environment variable names are:

```text
FITNESS_CLOUDBASE_ENV_ID
FITNESS_PUBLIC_OPERATOR_NAME
FITNESS_PUBLIC_PRIVACY_CONTACT
FITNESS_PRIVACY_NOTICE_VERSION
FITNESS_REVIEWED_DATASET_ID
FITNESS_CLOUDBASE_CONFIGURED_NAMES
```

`FITNESS_CLOUDBASE_CONFIGURED_NAMES` is a comma-separated set of names, never values.

- [x] **Step 2: Add RED artifact/secret scan tests**

Seed fixtures containing `.map`, test files, `node_modules`, local fixture markers, OpenID-shaped log values, Base64 image values, concrete `cloud://` file IDs in evidence/logs, high-entropy `secret=`/`token=` assignments, and unapproved output paths. Assert a clean build contains only the three allowlisted function directories with `index.js`/`package.json` and the mini program tree. Explicitly assert safe identifiers and validators such as `snapshotToken`, `estimatedTokenUnits`, `CLOUDBASE_STORAGE_FILE_ID_PREFIX`, and the literal `cloud://` validation prefix do not trigger without a secret/file-ID value.

The scanner allows public operator/contact/version values in the mini program, but forbids `.env`, private config, server settings, and evidence files from any deploy artifact.

- [x] **Step 3: Run tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- scripts/lib/release-config.test.ts scripts/release-preflight.test.ts scripts/scan-release-artifacts.test.ts miniprogram/build.test.ts tests/e2e/cloudfunction-deploy-artifact.test.ts
```

Expected: FAIL because the validators, release manifest, and scripts do not exist.

- [x] **Step 4: Implement release build mode and pure validators**

Add `build:miniprogram:release` which invokes:

```text
node scripts/build-miniprogram.mjs --api-mode=cloud --release-channel=controlled_beta
```

Controlled-beta mode rejects local values and injects the three public metadata values. Ordinary `build` stays reproducible with explicit development-only metadata and cannot be mistaken for a release artifact because preflight rejects its channel.

Implement exact JSON/config comparisons using parsed objects, not regular expressions. `project.private.config.json` is read only to classify the AppID as present and non-tourist; neither AppID nor environment ID enters evidence/output.

- [x] **Step 5: Implement artifact and sensitive-log scanning**

Walk only resolved paths under `.build/cloudfunctions`, `.build/miniprogram`, and `.build/release-evidence`. Refuse symlinks. Scan text files with bounded reads. Apply artifact secret-value rules to deploy code and stricter personal-data/file-ID rules to logs/evidence; do not treat safe field names as values. Report relative path plus rule ID, not matched content. Add package commands:

```json
{
  "scripts": {
    "build:miniprogram:release": "node scripts/build-miniprogram.mjs --api-mode=cloud --release-channel=controlled_beta",
    "release:preflight": "node scripts/release-preflight.mjs",
    "release:scan": "node scripts/scan-release-artifacts.mjs"
  }
}
```

- [x] **Step 6: Run focused tests and a development build scan**

Run:

```powershell
pnpm.cmd test -- scripts/lib/release-config.test.ts scripts/release-preflight.test.ts scripts/scan-release-artifacts.test.ts miniprogram/build.test.ts tests/e2e/cloudfunction-deploy-artifact.test.ts
pnpm.cmd build
pnpm.cmd release:scan
```

Expected: tests and scan PASS. `release:preflight` is expected to fail in a workspace without real private release inputs; its behavioral tests must pass.

- [x] **Step 7: Commit**

```powershell
git add scripts package.json miniprogram/build.test.ts tests/e2e/cloudfunction-deploy-artifact.test.ts docs/release/phase-7-release-manifest.json
git commit -m "build: add phase seven release preflight"
```

### Task 4: Capacity Evidence and Release-check Orchestrator

**Files:**
- Create: `scripts/lib/release-command-runner.mjs`
- Create: `scripts/lib/release-command-runner.test.ts`
- Create: `tests/support/capacity-planning-api.ts`
- Create: `scripts/build-capacity-planning-api.mjs`
- Create: `scripts/release-capacity.mjs`
- Create: `scripts/release-capacity.test.ts`
- Create: `scripts/release-check.mjs`
- Create: `scripts/release-check.test.ts`
- Create: `tests/e2e/personal-data-capacity.test.ts`
- Modify: `tests/e2e/cloudfunction-deploy-artifact.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: all preceding release validators and the Phase 7A API behavior.
- Produces local capacity evidence shape:

```ts
interface CapacityEvidenceV1 {
  readonly schemaVersion: 'phase-7-capacity-evidence-v1';
  readonly mode: 'local_baseline' | 'cloud_controlled_beta';
  readonly identityCount: 10;
  readonly operationsPerIdentity: 30;
  readonly totalOperations: 300;
  readonly planningSuccessRate: number;
  readonly providerBoundedOutcomeRate: number;
  readonly p95LatencyMs: number;
  readonly crossUserLeakCount: number;
  readonly partialTransactionCount: number;
  readonly duplicateEffectiveVersionCount: number;
  readonly lostCleanupCount: number;
  readonly providerTimeoutViolationCount: number;
  readonly quotaViolationCount: number;
  readonly budgetExceeded: boolean;
  readonly status: 'passed' | 'failed';
}
```

Pass thresholds are non-Provider planning success `1.0`, Provider success-or-fixed-degradation `1.0`, p95 `< 5000`, all defect/timeout/quota counts `0`, and `budgetExceeded: false`.

- [ ] **Step 1: Write RED 3 MB response-budget and 10×30 workload tests**

Generate the largest valid aggregate at or below `3_000_000` bytes using visible assistant messages and planning versions, then assert its export serializes below 6 MB and parses through `planningApiResponseSchema`. Assert a one-byte-larger write fails with `account_capacity_exceeded` without changing the prior state. Before the measured workload, seed each identity through the reviewed local Provider with one active weekly meal plan; exclude that provider setup from the 30 measured non-provider operations.

Build `tests/support/capacity-planning-api.ts` with esbuild into ignored `.build/release-capacity/server.mjs` and spawn it as a real loopback-only Node process. This local-only server composes the real planning handler over one shared in-memory repository plus a reviewed test Provider that fails the first designated recalculation once per identity, accepts identity only from `x-fitness-capacity-identity`, and allows exactly `tester-01` through `tester-10`; it is absent from every cloud/miniprogram artifact. A separate loopback-only seed route prepares the maximum aggregate and weekly meal state but is not part of the planning API or deploy bundle. Drive the maximum export and all 300 operations over HTTP, wait for its own readiness marker, terminate only its direct child process, await exit, and rebind the allocated port to prove cleanup.

Run 10 contexts concurrently. Each performs exactly 30 mixed operations from this fixed mix: 1 planning setup, 4 training-plan version changes, 3 successful training-completion writes, 1 completion with a fixed Provider/recalculation failure, 1 successful `retryPendingRecalculation`, 4 meal lock/unlock writes, 4 personal summary reads, 4 context reads, 4 exports, 1 failed stale-token export, 2 idempotent repeats, and 1 final context read. Classify operations before execution as Provider-touching or non-Provider. Assert the injected failure leaves the prior active meal intact with one retryable job, retry creates one valid successor, per-user version chains remain complete, and no data overlaps.

- [ ] **Step 2: Write RED evidence-validator tests**

`release-capacity.mjs` reads either a just-produced local result or `.build/release-evidence/cloud-capacity-input.json`, validates the exact shape/thresholds, hashes identity labels before output, and writes `.build/release-evidence/capacity-validation.json`. Test missing identities, 299 operations, 5,000 ms p95, 99.9% non-Provider success, an unbounded Provider outcome, any partial transaction/leak/duplicate/lost cleanup/timeout/quota violation, budget excess, and raw OpenID presence as failures.

- [ ] **Step 3: Write RED release-check order/failure tests**

Inject a fake command runner and assert exact fail-fast order:

```text
release:preflight
lint
typecheck
test
build
dry-run:api
dry-run:photo-cleanup
dry-run:assistant
smoke:api
smoke:assistant
release:dataset
release:capacity
release:scan
git diff --check
git status --short
```

The orchestrator permits only the pre-existing `.pnpm-store/` untracked path plus ignored `.build`; any other unstaged/untracked release source fails.

- [ ] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
pnpm.cmd test -- tests/e2e/personal-data-capacity.test.ts scripts/release-capacity.test.ts scripts/release-check.test.ts scripts/lib/release-command-runner.test.ts
```

Expected: FAIL because capacity validation and orchestration do not exist.

- [ ] **Step 5: Implement deterministic metrics and orchestrator**

Use `performance.now()` for latency, nearest-rank p95 over all planning operations, and integer counters. Evidence stores only aggregate metrics and SHA-256 identity labels. `release-check` spawns each command without a shell, streams output, stops on first non-zero exit, and writes baseline commit, SHA-256 for the three function entries and mini program artifact manifest, plus only command name, exit code, start/end timestamps, and status to `.build/release-evidence/release-check.json`.

Add:

```json
{
  "scripts": {
    "release:capacity": "node scripts/release-capacity.mjs",
    "release:check": "node scripts/release-check.mjs"
  }
}
```

- [ ] **Step 6: Run local capacity and release-script regressions**

Run:

```powershell
pnpm.cmd test -- tests/e2e/personal-data-capacity.test.ts scripts
pnpm.cmd release:capacity
```

Expected: PASS in `local_baseline` mode and a passing anonymized evidence file. Do not run `release:check` until real release inputs exist; its test suite proves behavior in isolation.

- [ ] **Step 7: Commit**

```powershell
git add scripts package.json tests/e2e/personal-data-capacity.test.ts
git commit -m "build: add capacity and release check gates"
```

### Task 5: Production-data Runbook and Phase 7B Verification

**Files:**
- Create: `docs/cloudbase/phase-7-reviewed-dataset.md`
- Modify: `README.md`
- Modify: `DEVELOPMENT_PROGRESS.md`
- Create: `.env.example`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a release operator contract and verified local code readiness without claiming real dataset/license/deployment acceptance.

- [ ] **Step 1: Document candidate-to-active dataset promotion**

Specify this fail-closed sequence:

1. obtain source and commercial cache/display authorization offline;
2. normalize to `reviewed-planning-dataset-v1` without credentials or supplier raw response;
3. set `FITNESS_REVIEWED_DATASET_FILE` to the resolved absolute path of the private candidate outside the repository, then run `pnpm.cmd release:dataset`;
4. inspect passing evidence and import the exact checksummed document to `planning_reviewed_datasets` under its `datasetId`;
5. verify the document in isolation without changing `FITNESS_REVIEWED_DATASET_ID`;
6. back up the current active dataset and user-state collections;
7. change only the server-side active dataset ID;
8. run real provider acceptance; on failure restore the prior ID, never mutate the prior dataset document.

Document license owner, evidence owner, expiry-review date, and rollback decision as required operational fields—kept in private release evidence, not in the repository.

- [ ] **Step 2: Add safe example variable names**

Add only names and non-secret format descriptions to `.env.example`; do not provide a dataset ID, environment ID, AppID, provider key, contact address, or storage prefix value.

- [ ] **Step 3: Run the complete local Phase 7B gate**

Run:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd dry-run:photo-cleanup
pnpm.cmd dry-run:assistant
pnpm.cmd smoke:api
pnpm.cmd smoke:assistant
pnpm.cmd release:capacity
pnpm.cmd release:scan
git diff --check
```

Expected: every command exits 0. `release:dataset`, `release:preflight`, and `release:check` remain external-input gates and are not marked passed without a real reviewed dataset and release configuration.

- [ ] **Step 4: Update progress truthfully and audit**

Record the exact command results in Phase 7. Mark code, strict dataset adapter, and local release-tooling items complete only if the commands ran. Keep reviewed source/license, active dataset import, real CloudBase preflight, provider acceptance, two-account isolation, backup/restore, and device testing unchecked.

Run:

```powershell
git status --short
git diff --stat
git diff --check
rg -n "test_fixture|unavailableNutritionProvider|unavailableRecipeProvider|unavailableMenuProvider" cloudfunctions packages/providers
```

Expected: cloud runtime contains no fixture/unavailable meal provider; local test runtime may still contain explicit fixtures. `.pnpm-store/` remains untouched.

- [ ] **Step 5: Commit**

```powershell
git add docs/cloudbase/phase-7-reviewed-dataset.md README.md DEVELOPMENT_PROGRESS.md .env.example
git commit -m "docs: verify phase seven production data gates"
```
