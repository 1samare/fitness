# Phase 7C Controlled Beta Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the verified schema-v8 system and reviewed dataset to a real CloudBase controlled-beta environment, complete capacity/security/provider/privacy/backup/device acceptance, and hand testers a reproducible validation package.

**Architecture:** Treat rollout as a forward-compatible three-function migration with explicit evidence checkpoints: v8-aware cleanup first, planning second, assistant third, and mini program last. Cloud configuration, datasets, licenses, identities, screenshots, and restore outputs remain private external evidence; the repository stores only the runbook, validator code, public documentation, and pass/fail summaries.

**Tech Stack:** CloudBase document database/private storage/cloud functions, CloudBase CLI `@cloudbase/cli@3.7.2`, WeChat DevTools and physical devices, native mini program, PowerShell, repository release scripts from Phase 7B.

**Spec:** `docs/superpowers/specs/2026-08-20-phase-7-cloud-integration-controlled-beta-design.md`

## Global Constraints

- Work only on `feat/v1.0`; do not create a branch or worktree.
- This plan performs external writes and deployment only after the release operator confirms the exact CloudBase environment is the dedicated controlled-beta target.
- Never print, commit, or copy into task messages an AppID, environment ID, OpenID, provider key, storage file ID, health profile, private contact, dataset file, backup payload, or user free text.
- Use fixed CloudBase CLI `@cloudbase/cli@3.7.2`; verify its live help before write operations.
- Do not deploy if the active cleanup timer would be removed or if any currently active function cannot read schema v8.
- Deploy order is `photo-cleanup` → `planning-api` → `assistant-api` → controlled-beta mini program.
- A new reviewed dataset is imported and validated before switching `FITNESS_REVIEWED_DATASET_ID`; failed candidates never replace the prior active ID.
- A database restore always targets new named collections; never overwrite the live collection during rehearsal.
- Real acceptance needs at least two separate WeChat identities for isolation and ten identities for the 10×30 capacity gate.
- Phase 7 is not complete while any required real-provider, backup/restore, privacy/legal, capacity, two-account, or physical-device evidence is missing.
- Destructive cleanup of restore-drill collections or test accounts requires a separate explicit confirmation after evidence is retained.

---

### Task 1: Freeze Release Inputs, Reviewed Data, and Rollback Point

**Files:**
- Create: `docs/cloudbase/phase-7-controlled-beta-release.md`
- Modify: `DEVELOPMENT_PROGRESS.md`
- External/private: `project.private.config.json`
- External/private: reviewed dataset input selected by `FITNESS_REVIEWED_DATASET_FILE`
- External/private evidence directory: `.build/release-evidence/`

**Interfaces:**
- Consumes: Phase 7A/7B code, `release:dataset`, `release:preflight`, real public operator/contact/notice values, and a dedicated target environment.
- Produces: passing dataset and preflight evidence plus an identified restore time; no deploy occurs in this task.

- [ ] **Step 1: Confirm branch, immutable revision, and clean release source**

Run:

```powershell
git branch --show-current
git status --short
git rev-parse HEAD
git diff --check
```

Expected: branch is `feat/v1.0`; only the known user-owned `.pnpm-store/` may be untracked; no source changes are unstaged. Record the commit SHA in private evidence, not in `DEVELOPMENT_PROGRESS.md` until rollout finishes.

- [ ] **Step 2: Verify the fixed CLI and live command surface read-only**

Run:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb --version
npx -y --package @cloudbase/cli@3.7.2 tcb fn deploy --help
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update --help
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql restore --help
```

Expected: version `3.7.2`; help exposes `fn deploy`, `fn code update`, environment selection, non-interactive confirmation, and restore-to-new-table mapping. If live help differs from the approved runbook, stop and update the runbook through a reviewed code change before any write.

- [ ] **Step 3: Validate the private reviewed dataset**

With `FITNESS_REVIEWED_DATASET_FILE` pointing to the private candidate and `FITNESS_RELEASE_NOW` fixed to the release timestamp, run:

```powershell
pnpm.cmd release:dataset
```

Expected: `dataset-validation.json` status is passed; checksum, license/cache/display permissions, review/expiry, and closed graph pass. The evidence contains no raw dataset records or source credentials.

- [ ] **Step 4: Import and isolate-verify the candidate without activating it**

In the CloudBase console for the confirmed controlled-beta environment:

1. create or select `planning_reviewed_datasets`;
2. insert one document whose document ID exactly equals the validated `datasetId` and whose body exactly matches the validated checksummed JSON;
3. leave the existing `FITNESS_REVIEWED_DATASET_ID` unchanged;
4. inspect the stored document count and checksum through a read-only administrative view;
5. record only `import present`, dataset version, checksum, and validation time in private evidence.

Expected: candidate is present and unchanged; the running service still points at the prior active ID.

- [ ] **Step 5: Verify restorable range and both collections**

Set `FITNESS_RESTORE_CHECK_TIME` to a time inside the returned restorable range, then run:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql restore-time -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql restore-tables --time $env:FITNESS_RESTORE_CHECK_TIME --filters "planning_user_states,planning_reviewed_datasets" -e $env:FITNESS_CLOUDBASE_ENV_ID
```

Expected: both collections are available at the selected point. Store only availability, selected timestamp, and request/task IDs in private evidence.

- [ ] **Step 6: Close the private compliance and scientific-review packet**

Before preflight, obtain and record in the controlled evidence system:

- the exact table/page, reviewer, and review date for every production constant taken from 《中国居民膳食营养素参考摄入量（2023 版）》, with any difference routed to a new policy version rather than historical rewrite;
- nutrition source owner, commercial authorization reference, cache/derivation/display/attribution permissions, validity/exit terms, and approval owner;
- model Provider/model ID, mainland filing/registration evidence, AI-generated-content labeling evidence, and WeChat platform review status;
- matching public privacy notice, WeChat privacy-protection guide, operator, contact, retention periods, third-party list, data-subject rights, and evidence-retention policy;
- controlled-beta budgets and alerts for Cloud Functions, database operations/egress, storage, vision calls, LLM tokens/calls, and reviewed-data renewal.

Expected: every item has an owner, evidence reference, review date, and `approved` status. No contract, personal data, contact value, provider body, or secret enters the repository.

- [ ] **Step 7: Run release preflight and full release check**

After the operator configures only the required environment names/values in CloudBase and the real public privacy metadata locally, run:

```powershell
pnpm.cmd release:preflight
pnpm.cmd release:check
```

Expected: both exit 0 using the passing `local_baseline` capacity evidence. If `release:check` detects dirty release source, local-only metadata, missing dataset/capacity evidence, a secret/sensitive-log match, or wrong config/version, stop rollout. The final Task 5 run must instead consume passing `cloud_controlled_beta` capacity evidence.

- [ ] **Step 8: Update only in-progress evidence notes**

Add the validated commit SHA and pass/fail timestamp to the Phase 7 evidence table. Keep rollout and acceptance checkboxes unchecked.

### Task 2: Forward-compatible CloudBase Function and Mini Program Deployment

**Files:**
- External: CloudBase functions/config/rules in the dedicated controlled-beta environment
- External: WeChat controlled-beta build
- Modify after successful deploy: `docs/cloudbase/phase-7-controlled-beta-release.md`

**Interfaces:**
- Consumes: Task 1 passing release check and built artifacts.
- Produces: real schema-v8-aware functions and a controlled-beta mini program tied to the reviewed dataset.

- [ ] **Step 1: Build and hash the exact release artifacts**

Run:

```powershell
pnpm.cmd build
pnpm.cmd build:miniprogram:release
pnpm.cmd release:scan
Get-FileHash -Algorithm SHA256 .build/cloudfunctions/photo-cleanup/index.js
Get-FileHash -Algorithm SHA256 .build/cloudfunctions/planning-api/index.js
Get-FileHash -Algorithm SHA256 .build/cloudfunctions/assistant-api/index.js
```

Expected: scans pass; store only function name plus hash in private evidence. Do not rebuild between hashing and deployment.

- [ ] **Step 2: Inspect existing functions and protect the cleanup timer**

Run read-only details:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn detail photo-cleanup --json -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb fn detail planning-api --json -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb fn detail assistant-api --json -e $env:FITNESS_CLOUDBASE_ENV_ID
```

Classify each as existing or absent. If `photo-cleanup` exists with the 15-minute timer, use code-only update for all existing functions. If functions are absent, create them with the reviewed config and activate the cleanup timer before admitting uploads. Never use `fn deploy --force` against an existing cleanup function with a live trigger because deploy overwrites configuration and triggers.

- [ ] **Step 3: Publish and verify rules, IAM, index, and early-schema gates**

Publish the reviewed `cloudbase/database.rules.json`, `cloudbase/storage.rules.json`, and `cloudbase/function.rules.json` to the exact beta environment. Verify database client read/write is denied; storage access is authenticated, owner-scoped, and limited to `ingredient-photos/`; planning/assistant are authenticated-only; cleanup is client-denied; and only the planning function service identity may call the configured vision function.

Create/verify the exact compound index `state.nextPhotoCleanupAt ASC, state.userId ASC`. Count every v6/v7 document with a non-null cleanup time and prove missing trusted `state.userId` count is zero; never infer identity from a document hash. Do not enable a timer or upload until these checks pass.

- [ ] **Step 4: Deploy or code-update `photo-cleanup` first**

For an existing function:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update photo-cleanup --yes -e $env:FITNESS_CLOUDBASE_ENV_ID
```

For an absent function:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn deploy photo-cleanup --yes -e $env:FITNESS_CLOUDBASE_ENV_ID
```

Before timer activation, invoke one administrator-only cleanup scan against known disposable due data and verify success plus correct private-object handling. Then activate exactly `photo-cleanup-every-15-minutes` with config `0 */15 * * * * *` in CloudBase before any beta photo upload. Run `fn detail` again and verify Nodejs20.19, `index.main`, 25 seconds, no client invoke, timer present, and code hash/version.

- [ ] **Step 5: Activate the candidate dataset and deploy planning**

Change only the server-side `FITNESS_REVIEWED_DATASET_ID` to the already validated candidate ID. Keep all values private. Then update/create planning:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update planning-api --yes -e $env:FITNESS_CLOUDBASE_ENV_ID
```

Use `fn deploy planning-api --yes` instead only when the read-only detail proved it absent. Verify Nodejs20.19, `index.main`, 25 seconds, authenticated-only invoke rule, the required six server config names, and v2-v8 read/v8 write smoke. Do not deploy assistant until planning smoke succeeds.

- [ ] **Step 6: Deploy assistant last**

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb fn code update assistant-api --yes -e $env:FITNESS_CLOUDBASE_ENV_ID
```

Use deploy only if absent. Verify Nodejs20.19, `index.main`, 120 seconds, authenticated-only invoke, approved provider/model/function-name configuration, and no client access to photo cleanup.

- [ ] **Step 7: Publish the controlled-beta mini program**

Open `.build/miniprogram` through the real `project.private.config.json`, verify the displayed operator/contact/notice version and `controlled_beta` channel, then upload the exact build to WeChat's controlled test channel. Do not use the tourist AppID or a development-metadata build.

- [ ] **Step 8: Record deploy evidence and rollback handles**

Record function versions/hashes, mini program upload version, active dataset version/checksum, rule review status, and the previous function/dataset versions in private evidence. Add only the pass/fail summary and timestamp to the repository runbook.

### Task 3: Real Functional, Isolation, Provider, and Privacy Acceptance

**Files:**
- External/private: two-account/device acceptance records
- External/private: provider observation metrics
- Modify after all passes: `docs/cloudbase/phase-7-controlled-beta-release.md`

**Interfaces:**
- Consumes: Task 2 deployed system.
- Produces: real evidence for user flows, data isolation, fail-closed providers, account rights, content labels, and cleanup.

- [ ] **Step 1: Execute the complete happy path on two separate identities**

Tester A and Tester B each use a physical device and separate WeChat identity to complete:

```text
身体档案/偏好 → 目标 → 一周训练计划 → 每日营养目标 → 库存 → 周食谱 → 锁定/修改 → 训练完成反馈 → 助手有限修改 → 数据导出
```

Acceptance: all current/future version links are consistent; past facts stay unchanged; locked/manual meal days require confirmation; every numeric result shows estimated/non-medical copy; AI-assisted content shows a visible AI label.

- [ ] **Step 2: Prove cross-user and client-boundary isolation**

Using normal client capabilities only, prove A cannot read, export, edit, delete, download, overwrite, or enumerate B's aggregate or photo path; B cannot do the same to A. Prove both clients cannot call `photo-cleanup` or directly access either database collection. Record only anonymized identity hashes and pass/fail matrix.

- [ ] **Step 3: Exercise real reviewed nutrition success and fail-closed behavior**

Success: resolve reviewed food names, save inventory, generate a full week, replace a dish, resize a portion, and independently recompute displayed grams/nutrients from the active reviewed snapshots.

Failure drill in the dedicated beta environment: during a declared maintenance window, set the active dataset ID to a nonexistent ID, verify inventory save/meal generation fail with the fixed provider-unavailable path while context reads and deterministic planning remain usable, then restore the prior ID and verify recovery. Do not point at a fixture or silently fall back.

Also block acquisition/import of a new candidate and prove the already active authorized cache continues; validate an expired-license and broken-source-chain candidate in isolation and prove neither can become active. Do not expire the active production-authorized document merely to test candidate validation.

- [ ] **Step 4: Exercise vision, assistant, and storage failure paths**

For vision, exercise invalid candidate schema, 8-second timeout, one retry, circuit open, half-open probe, manual entry, and recovery without logging file IDs/bodies. For assistant, exercise invalid output schema, exactly one controlled repair, 20-second transport timeout, one retry, three complete failures opening the 60-second circuit, half-open recovery, and proof that only the single configured Provider is called. Throughout, structured planning/meal actions continue and no model numeric output reaches deterministic state.

For delete retry, use a dedicated disposable tester account with a private photo. Temporarily revoke only the planning function's storage-delete capability, submit the exact deletion command, verify normal account APIs become pending/blocked and all business data remains, restore capability, retry the exact command, and verify document plus object are absent. Restore IAM before continuing.

- [ ] **Step 5: Prove cleanup timing and logs**

Confirm a photo-confirmation cleanup becomes eligible immediately and the 15-minute worker reaches `deleted` or idempotent `not_found`. Confirm all unconfirmed originals remain scheduled within 24 hours. Search cloud logs for Base64, signed URLs, OpenID, complete profiles/free text, secrets, and provider request bodies; every search must return zero sensitive matches. Provider observation logs may contain only provider/model or dataset version, request ID, attempt, latency, status, stable error code, and estimated cost/token units. Trigger each configured controlled-beta cost/quota alert with synthetic threshold configuration or provider test controls, verify notification ownership, then restore normal thresholds without incurring uncontrolled paid traffic.

- [ ] **Step 6: Validate data rights and content/privacy disclosures**

On both devices verify the privacy page displays the real operator, contact, notice version, collection purpose, retention, access/export/delete rights, AI/deterministic origin labels, and non-medical limitation. Export must parse, omit all banned internal fields, and match the tester's visible history. Complete one successful no-photo deletion and the failure/retry photo deletion above; both must clear local state and allow a clean recreated account.

- [ ] **Step 7: Record functional acceptance**

Record device OS/model class, mini program version, function/dataset versions, scenario IDs, timestamps, and pass/fail only. Screenshots containing health/free text stay in access-controlled private evidence and are deleted according to the test evidence retention policy.

### Task 4: 10×30 Capacity, Restore, Rollback, and Physical-device Gate

**Files:**
- External/private input: `.build/release-evidence/cloud-capacity-input.json`
- External/private restore evidence
- Modify: `docs/cloudbase/phase-7-controlled-beta-release.md`
- Modify: `DEVELOPMENT_PROGRESS.md`

**Interfaces:**
- Consumes: Phase 7B `release:capacity`, live functions, ten tester identities, and Task 1 restore point.
- Produces: passing real capacity and restore evidence and a rehearsed forward rollback.

- [ ] **Step 1: Coordinate ten identities and execute exactly 300 operations**

At a synchronized start time, each of ten authenticated testers performs the fixed 30-operation non-provider workload defined by Phase 7B. Capture client start/end latency and terminal response kind without request bodies. Use CloudBase logs to confirm exactly 300 accepted test operations and segregated identity hashes.

Acceptance:

```text
identityCount = 10
operationsPerIdentity = 30
totalOperations = 300
planningSuccessRate = 1.0
providerBoundedOutcomeRate = 1.0
p95LatencyMs < 5000
crossUserLeakCount = 0
partialTransactionCount = 0
duplicateEffectiveVersionCount = 0
lostCleanupCount = 0
providerTimeoutViolationCount = 0
quotaViolationCount = 0
budgetExceeded = false
```

Additionally, every Provider request completes within its declared success/degradation timeout, function/database/storage response sizes and concurrency stay inside the target environment's current quotas, and measured provider/function/database/storage cost stays inside the approved controlled-beta budget. Record quota names, plan tier, metric totals, and pass/fail privately without environment IDs or request bodies.

- [ ] **Step 2: Validate cloud capacity evidence**

Write only the exact anonymized evidence shape to `.build/release-evidence/cloud-capacity-input.json`, set mode `cloud_controlled_beta`, and run:

```powershell
pnpm.cmd release:capacity
```

Expected: exits 0 and writes passing capacity validation. Any threshold miss keeps Phase 7 incomplete and starts a diagnosed fix cycle.

- [ ] **Step 3: Restore both collections to new names**

After confirming the exact environment and restore timestamp again, run:

```powershell
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql restore --time $env:FITNESS_RESTORE_CHECK_TIME --tables '[{"OldTableName":"planning_user_states","NewTableName":"planning_user_states_phase7_restore_drill"},{"OldTableName":"planning_reviewed_datasets","NewTableName":"planning_reviewed_datasets_phase7_restore_drill"}]' -e $env:FITNESS_CLOUDBASE_ENV_ID
npx -y --package @cloudbase/cli@3.7.2 tcb db nosql restore-task -e $env:FITNESS_CLOUDBASE_ENV_ID
```

Expected: restore task succeeds into the two exact new names. Compare document counts, schema distribution, sample anonymized hashes, active version relationships, dataset checksum, A/B separation, photo cleanup deadlines, pending deletion markers, assistant pending turns, and assistant receipts; record restore duration and backup retention window. Never route application traffic to the drill collections. Any restored photo reference already past its original deletion deadline must be processed immediately by a controlled cleanup against the restored reference, never granted a new retention window.

- [ ] **Step 4: Rehearse forward rollback without schema downgrade**

Restore the previous reviewed dataset ID and previous v8-aware function code versions, in order `photo-cleanup` → `planning-api` → `assistant-api`, while keeping one working cleanup path. Verify current v8 documents remain readable and no history is rewritten. Then reapply the approved new versions in the same forward order and repeat smoke.

Do not deploy any v7-only planning/cleanup/assistant artifact and do not change stored schema v8 documents to v7.

- [ ] **Step 5: Complete physical-device and network conditions**

Run the core flow on at least one iOS and one Android device, including fresh install, background/resume, duplicate tap/idempotent retry, Wi-Fi-to-mobile switch, provider timeout, image upload retry, export clipboard, and deletion/relaunch. Confirm no page is blocked by a development-only route or console action.

- [ ] **Step 6: Request separate confirmation for evidence cleanup**

After restore comparison and evidence retention are confirmed, request explicit operator authorization to delete only:

```text
planning_user_states_phase7_restore_drill
planning_reviewed_datasets_phase7_restore_drill
dedicated disposable tester accounts and their private objects
```

Do not delete these targets as part of an implicit cleanup. Record whether cleanup occurred and its recoverability/retention status.

### Task 5: Final Tester Handoff and Phase Completion

**Files:**
- Create: `docs/testing/phase-7-controlled-beta-checklist.md`
- Modify: `docs/cloudbase/phase-7-controlled-beta-release.md`
- Modify: `README.md`
- Modify: `DEVELOPMENT_PROGRESS.md`

**Interfaces:**
- Consumes: every passing local and real gate from all three Phase 7 plans.
- Produces: tester-ready instructions and the only valid Phase 7 completion update.

- [ ] **Step 1: Write the tester checklist**

Include exact entry pages, supported healthy-adult boundary, test-data preparation, happy path, meal lock/manual confirmation, AI assistant supported commands, photo manual fallback, export inspection, irreversible deletion confirmation, expected fixed errors, privacy contact route, and evidence-redaction rules. State that diseases, pregnancy, minors, rehabilitation, medical advice, extreme goals, unsupported age/BMI, and missing health confirmation must not receive personalized energy adjustment.

- [ ] **Step 2: Re-run immutable local gates from the deployed revision**

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
pnpm.cmd release:check
git diff --check
```

Expected: every command exits 0; release evidence still corresponds to the deployed commit and artifact hashes.

- [ ] **Step 3: Perform final privacy and secret audit**

Run:

```powershell
git status --short
git diff --stat
git diff --check
git ls-files project.private.config.json .env .build
rg -n "OPENID|SECRET|API_KEY|cloud://|fileID|Base64|FITNESS_CLOUDBASE_ENV_ID" --glob "!docs/superpowers/plans/**" --glob "!docs/superpowers/specs/**"
```

Expected: no private config/evidence is tracked, and any matched code contains only safe field names/validators—not values or logged sensitive bodies. `.pnpm-store/` remains untouched.

- [ ] **Step 4: Update the single progress source truthfully**

Only when every required external gate above has evidence, mark Phase 7 and its acceptance items complete. Record exact local commands/results, CloudBase function/dataset versions by non-secret label, two-account/capacity/restore/device dates, remaining non-blocking limitations, and the next stage. If any gate lacks evidence, leave Phase 7 `进行中` and list the exact missing owner/input.

- [ ] **Step 5: Commit the final handoff**

```powershell
git add docs/testing/phase-7-controlled-beta-checklist.md docs/cloudbase/phase-7-controlled-beta-release.md README.md DEVELOPMENT_PROGRESS.md
git commit -m "docs: hand off phase seven controlled beta"
```

- [ ] **Step 6: Complete the active goal only after final evidence**

Call the goal-status completion operation only after the final commit and verification output exist. The handoff message must distinguish completed code readiness from real controlled-beta readiness; with all evidence present they are both complete.
