# Phase 6 Bounded Single Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete phase 6 with a LangGraph.js single Agent that safely executes three whitelisted planning commands through existing deterministic application services, persists a bounded recoverable conversation, and supports explicitly configured Hunyuan or DeepSeek through CloudBase AI+.

**Architecture:** Add an isolated `assistant-api` CloudBase function and a focused `@fitness/agent` package. The function binds trusted OpenID, conversation lifecycle, one fixed LangGraph, a resilient language-model adapter, and existing public planning services; the Agent never reads the database or supplies trusted numeric/domain data. Store schema-v7 conversation state in the existing per-user planning aggregate so identity, transactions, deletion scope, version checks, and deterministic command idempotency remain unified.

**Tech Stack:** TypeScript 5.9 strict mode, pnpm 9.15, Zod 4, Vitest 3, `@langchain/langgraph` 1.4.9, `@cloudbase/node-sdk` 3.18.3, wx-server-sdk 4, CloudBase Node.js 20.19 cloud functions, tsup 8, native WeChat Mini Program.

**Spec:** `docs/superpowers/specs/2026-08-19-phase-6-bounded-single-agent-design.md`

## Global Constraints

- Work only on `feat/v1.0`; do not create a branch or worktree.
- Preserve the pre-existing untracked `.pnpm-store/` and all unrelated user changes.
- Runtime orchestration is exactly one LangGraph.js `StateGraph`; no multi-Agent, dynamic tool names, arbitrary loops, public knowledge base, or shared checkpointer.
- Supported intents are exactly `move_training_day`, `replace_meal`, and `resize_meal_portion`.
- Client input contains one user message, expected conversation version, and idempotency key; it never contains trusted `userId`, history roles, summary, Provider, model, tool, URL, query, MET, grams, calories, or internal IDs.
- Model output is untrusted. Dates, meal slot, dish name, and portion multiplier must be deterministically re-parsed from exact evidence in the latest message or previously validated pending clarification.
- Portion multiplier is `0.50–1.50` inclusive in `0.05` steps; ingredient grams and nutrients are recalculated from reviewed recipe templates and nutrition snapshots.
- Model/schema/evidence repair is allowed exactly once. Provider transport retry is allowed once for transport/timeout failures and is distinct from model-output repair.
- Cloud Provider/model selection is explicit through `CLOUDBASE_ENV_ID`, `FITNESS_LLM_PROVIDER_ID`, and `FITNESS_LLM_MODEL`; missing configuration fails closed and never switches Provider automatically.
- Provider timeout is 20 seconds per transport attempt; circuit threshold is 3 failed complete operations, cooldown is 60 seconds, and half-open allows one probe.
- Persist at most 12 recent messages, one pending turn, a non-sensitive deterministic summary, and 32 recent receipts. Do not persist raw model output or full prompts.
- All assistant writes use trusted server identity, expected version, SHA-256 request fingerprint, and idempotency key. Provider calls occur outside database transactions.
- Existing past-fact, version, source, nutrition, inventory, food-diversity, allergen, lock/manual-edit, complete-before-activate, and rollback invariants remain authoritative.
- Local tests use explicit fixed fixtures; cloud-only artifacts contain no local identity path, fixture model, test nutrition data, or runtime switch to local mode.
- Real CloudBase AI+, model access, Hunyuan/DeepSeek enablement,备案/登记, AI content marking, WeChat IDE, and physical-device checks remain explicit external gates.

---

### Task 1: Schema-v7 Conversation Domain and Runtime Contracts

**Files:**
- Create: `packages/domain/src/assistant-conversation.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/versioned-planning.ts`
- Create: `packages/contracts/src/assistant-api.ts`
- Create: `packages/contracts/src/assistant-api.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/persistence/src/in-memory-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.ts`
- Modify: `packages/persistence/src/cloudbase-planning-repository.test.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.test.ts`

**Interfaces:**
- Produces: `AssistantConversationState`, `AssistantValidatedCommand`, `AssistantTurnResult`, `emptyAssistantConversationState()`, `assistantApiRequestSchema`, `assistantApiResponseSchema`, `assistantConversationStateSchema`.
- Changes aggregate persistence from schema v6 to v7 by adding `assistantConversation`.

- [ ] **Step 1: Write failing strict-contract and migration tests**

Add tests proving request strictness, 12/32 bounds, pending unions, safe summary fields, v6→v7 empty migration, v7 round-trip, wrong-user rejection, and aggregate invariant rejection for mismatched pending/receipt state. Include these concrete expectations:

```ts
expect(assistantApiRequestSchema.safeParse({
  action: 'sendAssistantMessage',
  payload: {
    expectedVersion: 0,
    idempotencyKey: 'assistant-turn-0001',
    message: '把 2026-08-24 的训练移到 2026-08-25',
    userId: 'attacker'
  }
}).success).toBe(false);

expect(decodePlanningDocument(v6Document, 'trusted-user').assistantConversation)
  .toEqual(emptyAssistantConversationState());
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm.cmd test -- packages/contracts/src/assistant-api.test.ts packages/contracts/src/planning-api.test.ts packages/persistence/src/cloudbase-planning-repository.test.ts packages/persistence/src/planning-aggregate-invariants.test.ts
```

Expected: FAIL because assistant schemas/state and schema-v7 decoding do not exist.

- [ ] **Step 3: Add the pure domain model and empty state factory**

Define the closed unions without importing Zod, CloudBase, LangGraph, or supplier DTOs:

```ts
export type AssistantValidatedCommand =
  | { readonly kind: 'move_training_day'; readonly sourceDate: string; readonly targetDate: string }
  | { readonly kind: 'replace_meal'; readonly businessDate: string; readonly slot: MealSlot; readonly dishNameZh: string }
  | { readonly kind: 'resize_meal_portion'; readonly businessDate: string; readonly slot: MealSlot; readonly multiplier: number };

export interface AssistantConversationState {
  readonly version: number;
  readonly recentMessages: readonly AssistantConversationMessage[];
  readonly summary: AssistantConversationSummary;
  readonly pendingTurn: AssistantPendingTurn | null;
  readonly recentReceipts: readonly AssistantTurnReceipt[];
}

export function emptyAssistantConversationState(): AssistantConversationState {
  return {
    version: 0,
    recentMessages: [],
    summary: {
      activeWeekStartDate: null,
      trainingPlanVersion: 0,
      mealPlanVersion: 0,
      lockedMealDates: [],
      pendingClarification: null
    },
    pendingTurn: null,
    recentReceipts: []
  };
}
```

Use strict finite enums for result/error/missing-field codes. A `received` pending turn stores the original user message and fingerprint; a `validated` pending turn additionally stores exactly one `AssistantValidatedCommand`.

- [ ] **Step 4: Add runtime schemas and public API contracts**

Implement strict request actions:

```ts
export const assistantApiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('getAssistantConversation') }).strict(),
  z.object({
    action: z.literal('sendAssistantMessage'),
    payload: z.object({
      expectedVersion: z.number().int().nonnegative(),
      idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
      message: z.string().trim().min(1).max(2_000)
    }).strict()
  }).strict()
]);
```

Export stored-state schemas separately from public response schemas so `pendingTurn.requestFingerprint` and internal commands never leak through `getAssistantConversation`.

- [ ] **Step 5: Implement schema-v7 persistence and invariants**

Change `StoredPlanningDocument['schemaVersion']` to `7`, accept v2–v7 on decode, and add only the empty conversation when decoding v2–v6:

```ts
const phase6Empty = {
  assistantConversation: emptyAssistantConversationState()
} as const;
```

In aggregate invariants enforce:

- message count `<= 12`, receipt count `<= 32`, locked dates sorted/unique/max 7;
- every message/turn/receipt belongs implicitly to the containing trusted user document and contains no userId field;
- a validated turn has a command and a received turn does not;
- pending key/fingerprint do not duplicate a receipt;
- receipt conversation versions are positive, unique, and no greater than current version;
- command multiplier is in `WEEKLY_MEAL_SERVING_MULTIPLIERS` without importing calculation into domain; the runtime schema uses the literal range/0.05 integer-step refinement.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused contract and persistence tests PASS.

- [ ] **Step 7: Run typecheck for changed workspaces**

Run:

```powershell
pnpm.cmd --filter @fitness/domain typecheck
pnpm.cmd --filter @fitness/contracts typecheck
pnpm.cmd --filter @fitness/persistence typecheck
```

Expected: all three exit 0.

- [ ] **Step 8: Commit**

```powershell
git add packages/domain packages/contracts packages/persistence
git commit -m "feat: persist bounded assistant conversations"
```

---

### Task 2: Deterministic Portion Editing

**Files:**
- Modify: `packages/domain/src/versioned-planning.ts`
- Modify: `packages/application/src/meal-plan-editing.ts`
- Modify: `packages/application/src/meal-plan-editing.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/contracts/src/planning-api.ts`
- Modify: `packages/contracts/src/planning-api.test.ts`
- Modify: `packages/persistence/src/planning-aggregate-invariants.ts`
- Modify: `cloudfunctions/planning-api/src/handler.ts`
- Modify: `cloudfunctions/planning-api/src/handler.test.ts`
- Modify: `miniprogram/services/planning-api.ts`
- Modify: `miniprogram/services/planning-api.test.ts`

**Interfaces:**
- Produces: `resizeMealPlanPortion(userId, WriteCommandEnvelope<{ businessDate; slot; multiplier }>): Promise<MealPlanVersion>`.
- Reuses: current provider snapshot, meal display snapshot, nutrition recomputation, inventory/diversity/allergen checks, past-fact gate, version CAS, and idempotency patterns from `updateMealPlanDay`.

- [ ] **Step 1: Write failing calculation/application tests**

Add tests with these exact behaviors:

```ts
it.each([0.5, 1.5])('recomputes an explicit %s serving from reviewed grams', async (multiplier) => {
  const result = await service.resizeMealPlanPortion('trusted-user', {
    expectedVersion: 1,
    idempotencyKey: `resize-${String(multiplier).replace('.', '-')}`,
    payload: { businessDate: '2026-08-24', slot: 'lunch', multiplier }
  });
  const lunch = result.days.find((day) => day.businessDate === '2026-08-24')
    ?.meals.find((meal) => meal.slot === 'lunch');
  expect(lunch?.servingMultiplier).toBe(multiplier);
});
```

Also cover 0.55 step acceptance, 0.56 rejection, past/today rejection, allergen hard failure, inventory failure, full-week diversity failure, nutrition infeasibility, provider graph race, expected-version conflict, same-key replay, same-key/different-payload rejection, and transaction rollback with unchanged active plan/version counts.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm.cmd test -- packages/application/src/meal-plan-editing.test.ts packages/contracts/src/planning-api.test.ts cloudfunctions/planning-api/src/handler.test.ts miniprogram/services/planning-api.test.ts
```

Expected: FAIL because the resize operation and API action do not exist.

- [ ] **Step 3: Refactor the existing manual-edit selector behind a shared pure helper**

Extract the existing `selectManualMealReplacement` body into a private `selectManualMealChange` helper. Apply two mechanical edits to that existing body: extend the input with `allowedMultipliers: readonly number[]`, and replace `for (const multiplier of WEEKLY_MEAL_SERVING_MULTIPLIERS)` with `for (const multiplier of input.allowedMultipliers)`. Then restore the public replacement function as this wrapper:

```ts
type ManualMealChangeInput = ManualMealReplacementInput & {
  readonly allowedMultipliers: readonly number[];
};

export function selectManualMealReplacement(
  input: ManualMealReplacementInput
): MealPlanDay | WeeklyMealInfeasibleResult {
  return selectManualMealChange({
    ...input,
    allowedMultipliers: WEEKLY_MEAL_SERVING_MULTIPLIERS
  });
}
```

Add `ManualMealPortionInput` without a client-supplied recipe ID. `selectManualMealPortion` finds the current day and slot, resolves that meal's `recipeTemplateVersionId` from the already loaded reviewed recipes, and calls the shared helper with the current recipe and one multiplier:

```ts
export interface ManualMealPortionInput
  extends Omit<ManualMealReplacementInput, 'replacementRecipe'> {
  readonly multiplier: number;
}

export function selectManualMealPortion(
  input: ManualMealPortionInput
): MealPlanDay | WeeklyMealInfeasibleResult {
  const currentMeal = input.currentPlan.days
    .find((day) => day.businessDate === input.businessDate)
    ?.meals.find((meal) => meal.slot === input.slot);
  const currentRecipe = input.recipes.find(
    (recipe) => recipe.id === currentMeal?.recipeTemplateVersionId
  );
  const multiplierAllowed = WEEKLY_MEAL_SERVING_MULTIPLIERS.some(
    (candidate) => candidate === input.multiplier
  );
  if (currentRecipe === undefined || !multiplierAllowed) {
    return infeasible([{
      businessDate: input.businessDate,
      code: 'target_nutrition_infeasible'
    }]);
  }
  const { multiplier, ...base } = input;
  return selectManualMealChange({
    ...base,
    replacementRecipe: currentRecipe,
    allowedMultipliers: [multiplier]
  });
}
```

Missing day/slot/recipe or an out-of-policy multiplier returns the same structured infeasible result before candidate evaluation. This keeps `selectManualMealReplacement` behavior unchanged while forcing resize to evaluate exactly one multiplier against the current reviewed recipe.

- [ ] **Step 4: Add the idempotent application method**

Use operation name `resizeMealPlanPortion`, fingerprint `{ expectedVersion, payload }`, Provider load outside transaction, a second full provider graph token immediately before commit, and CAS tokens for profile/goal/training/meal/inventory/target. On success create one complete successor with the target day `locked: true` and `manuallyModified: true`.

- [ ] **Step 5: Expose the structured planning API action**

Add a strict action so the deterministic core remains available without the Agent:

```ts
z.object({
  action: z.literal('resizeMealPlanPortion'),
  payload: writeEnvelopeSchema(z.object({
    businessDate: businessDateSchema,
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
    multiplier: z.number().min(0.5).max(1.5).refine((value) => Number.isInteger(value * 20))
  }).strict())
}).strict()
```

Map public conflicts through the existing sanitized planning error path. Update the miniprogram client even though the assistant page will call `assistant-api`, because structured fallback must expose the same deterministic feature.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused tests PASS and existing replacement tests remain green.

- [ ] **Step 7: Commit**

```powershell
git add packages/domain packages/application packages/contracts packages/persistence cloudfunctions/planning-api miniprogram/services
git commit -m "feat: add deterministic meal portion editing"
```

---

### Task 3: Whitelisted Assistant Command Facade

**Files:**
- Create: `packages/application/src/planning-assistant-commands.ts`
- Create: `packages/application/src/planning-assistant-commands.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**
- Consumes: `getCurrentContext`, recalculating `saveTrainingPlan`, `updateMealPlanDay`, and `resizeMealPlanPortion` from the current composite planning service.
- Produces: `createPlanningAssistantCommandService()` with `execute(userId, command, idempotencyKey)`.

- [ ] **Step 1: Write failing facade tests**

Cover:

- future in-week move preserves `sessionCode` and `durationMinutes` exactly;
- source missing, target occupied, same date, today/past, and cross-week reject before writes;
- exact unique `dishNameZh` resolves to the current selectable recipe ID;
- unavailable/ambiguous dish rejects before `updateMealPlanDay`;
- portion command forwards only the deterministic multiplier;
- internal idempotency key is passed unchanged;
- service errors return typed `AssistantCommandError` reasons without provider text.

Use a concrete expected call:

```ts
expect(planning.saveTrainingPlan).toHaveBeenCalledWith('trusted-user', {
  expectedVersion: 2,
  idempotencyKey: 'assistant-domain-turn-0001',
  payload: {
    ...activeTraining.payload,
    sessions: [{ ...activeTraining.payload.sessions[0], businessDate: '2026-08-25' }]
  }
});
```

- [ ] **Step 2: Run focused test and verify RED**

```powershell
pnpm.cmd test -- packages/application/src/planning-assistant-commands.test.ts
```

Expected: FAIL because the command facade does not exist.

- [ ] **Step 3: Implement the facade with a single execute switch**

```ts
export interface PlanningAssistantCommandService {
  execute(
    userId: string,
    command: AssistantValidatedCommand,
    idempotencyKey: string
  ): Promise<{ readonly command: AssistantValidatedCommand['kind']; readonly message: string }>;
}
```

Use `businessDateAt(now(), activeProfile.payload.businessTimezone)` and the active week’s seven exact dates. Use fixed Chinese success strings. Do not accept userId inside the command or resolve any Provider/model/tool supplied by the client.

- [ ] **Step 4: Run test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/application/src/planning-assistant-commands.ts packages/application/src/planning-assistant-commands.test.ts packages/application/src/index.ts
git commit -m "feat: expose bounded assistant planning commands"
```

---

### Task 4: LangGraph Single Agent and Deterministic Evidence Parser

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/src/model-contract.ts`
- Create: `packages/agent/src/evidence.ts`
- Create: `packages/agent/src/evidence.test.ts`
- Create: `packages/agent/src/single-agent.ts`
- Create: `packages/agent/src/single-agent.test.ts`
- Create: `packages/agent/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `LanguageModelProvider.generateIntent(input)` and a trusted toolbox callback bound by the cloud-function composition root.
- Produces: `createFitnessAssistantAgent`, fixed system/repair prompts, strict raw-output schema, evidence parser, and `AssistantLanguageModelInput/Result` types.

- [ ] **Step 1: Scaffold the focused package manifest and install the approved dependency**

Create a normal workspace package using existing TypeScript configuration. Pin the approved LangGraph version exactly:

```powershell
pnpm.cmd add --filter @fitness/agent @langchain/langgraph@1.4.9 --save-exact
```

Declare existing `@fitness/domain` and `zod` dependencies. Do not add LangChain Agent helpers, memory/checkpointer packages, OpenAI SDKs, or tool packages.

- [ ] **Step 2: Write failing evidence and graph tests**

Tests must prove:

- ISO date, Chinese slot aliases, `0.5–1.5 倍`, and `50%–150%` parse only from exact message substrings;
- multiplier is in the 0.05 policy set;
- pending clarification can contribute only previously validated fields;
- extra `userId`, `tool`, `url`, `sql`, numeric multiplier field, calories, grams, MET, duration, or arbitrary explanation invalidates model output;
- graph passes no more than the latest 12 messages to the Provider;
- malformed first output causes exactly one repair with a fixed feedback enum;
- malformed second output returns `model_output_invalid` and makes zero tool calls;
- Provider unavailable returns a fixed unavailable result;
- the persisted-authoritative command path makes zero model calls;
- graph has one compiled `StateGraph` and a finite fixed route.

Example hostile output:

```ts
const hostile = JSON.stringify({
  kind: 'command',
  intent: 'move_training_day',
  evidence: { sourceDateText: '2026-08-24', targetDateText: '2026-08-25' },
  userId: 'victim',
  tool: 'drop_database'
});
```

- [ ] **Step 3: Run tests and verify RED**

```powershell
pnpm.cmd test -- packages/agent/src/evidence.test.ts packages/agent/src/single-agent.test.ts
```

Expected: FAIL because the package implementation does not exist.

- [ ] **Step 4: Implement strict model contracts and evidence parsing**

Use a strict union where all candidate parameters are strings:

```ts
const rawDecisionSchema = z.discriminatedUnion('kind', [
  moveTrainingEvidenceSchema,
  replaceMealEvidenceSchema,
  resizePortionEvidenceSchema,
  clarifySchema,
  rejectSchema
]);
```

The parser returns an `AssistantValidatedCommand` only after exact-evidence lookup and deterministic normalization. It never parses a number from a model numeric field.

- [ ] **Step 5: Implement the fixed LangGraph**

Use `StateSchema`, `StateGraph`, `START`, and `END` from `@langchain/langgraph`. The graph nodes are `decide`, `validate`, `repair`, `validate_repair`, `route`, `clarify`, `reject`, and `execute`. Conditional edges must enumerate every destination. `execute` first calls an injected `authorizeCommand(command)` callback that persists/returns the authoritative command, then calls the trusted toolbox.

The fixed system prompt must state the three intents, JSON-only output, evidence-only parameter rule, and forbidden fields. Public result messages come only from deterministic templates/tool results.

- [ ] **Step 6: Run tests and verify GREEN**

Run the Step 3 command. Expected: all agent tests PASS.

- [ ] **Step 7: Typecheck the package and verify no forbidden imports**

```powershell
pnpm.cmd --filter @fitness/agent typecheck
rg -n "from ['\"](@cloudbase|wx-server-sdk)|database\(|collection\(|createReactAgent|createAgent" packages/agent
```

Expected: typecheck exits 0; `rg` returns no forbidden matches.

- [ ] **Step 8: Commit**

```powershell
git add packages/agent pnpm-lock.yaml
git commit -m "feat: add bounded LangGraph assistant"
```

---

### Task 5: Recoverable Conversation Lifecycle

**Files:**
- Create: `packages/application/src/assistant-conversation.ts`
- Create: `packages/application/src/assistant-conversation.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**
- Produces: `createAssistantConversationService()` with `getConversation`, `beginTurn`, `authorizeCommand`, and `finalizeTurn`.
- Does not import `@fitness/agent`; orchestration stays in `assistant-api`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover these state transitions:

```text
empty → received → validated → completed receipt
empty → received → provider/model/command fixed failure receipt
received + same key/same fingerprint → resume
validated + same key → return authoritative command
completed + same key/same fingerprint → replay result
same key/different fingerprint → idempotency_key_reused
pending + different key → conversation_busy
wrong expected version → conversation_version_conflict
```

Also prove that finalization trims messages to 12 and receipts to 32, summary includes only week/version/locked dates/pending clarification, and a finalization failure followed by retry does not duplicate the domain version.

- [ ] **Step 2: Run focused test and verify RED**

```powershell
pnpm.cmd test -- packages/application/src/assistant-conversation.test.ts
```

Expected: FAIL because lifecycle service does not exist.

- [ ] **Step 3: Implement `beginTurn` as one transaction**

Fingerprint `{ expectedVersion, message }` with the existing SHA-256 canonical fingerprint helper. Return a closed result:

```ts
type BeginAssistantTurnResult =
  | { readonly kind: 'received'; readonly turn: AssistantReceivedTurn; readonly messages: readonly AssistantConversationMessage[]; readonly summary: AssistantConversationSummary }
  | { readonly kind: 'validated'; readonly turn: AssistantValidatedTurn }
  | { readonly kind: 'replayed'; readonly result: AssistantTurnResult };
```

Do not call the model or command service inside the transaction.

- [ ] **Step 4: Implement authoritative command CAS**

`authorizeCommand(userId, turnId, command)` stores the first validated command. Concurrent callers read back that authoritative command; a different validated command for the same turn fails closed and is never executed.

- [ ] **Step 5: Implement deterministic finalization and safe summary**

`finalizeTurn` reloads current planning context through the existing service, builds the non-sensitive summary, appends the pending user message and fixed assistant response, increments conversation version exactly once, writes a receipt, clears pending, and applies `.slice(-12)`/`.slice(-32)` bounds. It must be idempotent for the same turn.

- [ ] **Step 6: Run test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/application/src/assistant-conversation.ts packages/application/src/assistant-conversation.test.ts packages/application/src/index.ts
git commit -m "feat: add recoverable assistant turns"
```

---

### Task 6: Resilient Hunyuan and DeepSeek Provider Adapter

**Files:**
- Create: `packages/providers/src/resilient-language-model-provider.ts`
- Create: `packages/providers/src/resilient-language-model-provider.test.ts`
- Create: `packages/providers/src/cloudbase-language-model-backend.ts`
- Create: `packages/providers/src/cloudbase-language-model-backend.test.ts`
- Modify: `packages/providers/src/index.ts`
- Modify: `packages/providers/package.json`

**Interfaces:**
- Implements: `AssistantLanguageModelProvider` from `@fitness/agent`.
- Produces: abstract `CloudBaseTextModel`, backend envelope mapping, observation schema, timeout/retry/circuit errors.

- [ ] **Step 1: Write failing Provider tests**

Cover Hunyuan-like and DeepSeek-like configuration using the same backend:

```ts
expect(generateText).toHaveBeenCalledWith({
  model: 'deepseek-v4-flash',
  messages: expect.arrayContaining([
    expect.objectContaining({ role: 'system' }),
    { role: 'user', content: '把 2026-08-24 的训练移到 2026-08-25' }
  ])
});
```

Also cover invalid envelope, empty text, supplier error field, 20-second timer timeout with fake timers, retry only once for transient/timeout, no retry for invalid envelope, operation-level failure counting, threshold 3, one half-open probe under concurrency, cooldown reset, successful close, and observation JSON excluding prompt/message/output/userId/API key.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
pnpm.cmd test -- packages/providers/src/resilient-language-model-provider.test.ts packages/providers/src/cloudbase-language-model-backend.test.ts
```

Expected: FAIL because Provider files do not exist.

- [ ] **Step 3: Implement the CloudBase backend against an abstract model**

The backend receives `providerId` only for observation and receives an already-created `CloudBaseTextModel`; it maps fixed system/repair prompts plus bounded messages into `generateText({ model, messages })`. Parse `text`, `usage`, `rawResponses`, and optional `error` with strict schemas. Supplier request ID may come only from whitelisted `request_id`, `requestId`, or `id` fields.

- [ ] **Step 4: Implement resilient operation-level policy**

Count one complete `generateIntent` operation as failed after its transport attempts are exhausted. Use a single in-flight half-open probe promise so concurrent calls receive circuit-open without contacting the backend. Emit only:

```ts
{
  provider, model, requestId, repairAttempt, attempt,
  latencyMs, status, estimatedCostUnits
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/providers
git commit -m "feat: add resilient CloudBase language models"
```

---

### Task 7: Authenticated `assistant-api` Cloud Function and Build Isolation

**Files:**
- Create: `cloudfunctions/assistant-api/package.json`
- Create: `cloudfunctions/assistant-api/tsconfig.json`
- Create: `cloudfunctions/assistant-api/tsup.config.ts`
- Create: `cloudfunctions/assistant-api/tsup.deploy.config.ts`
- Create: `cloudfunctions/assistant-api/src/handler.ts`
- Create: `cloudfunctions/assistant-api/src/handler.test.ts`
- Create: `cloudfunctions/assistant-api/src/runtime-identity.ts`
- Create: `cloudfunctions/assistant-api/src/runtime-identity.test.ts`
- Create: `cloudfunctions/assistant-api/src/runtime-handler.ts`
- Create: `cloudfunctions/assistant-api/src/runtime-handler.test.ts`
- Create: `cloudfunctions/assistant-api/src/cloud-runtime-handler.ts`
- Create: `cloudfunctions/assistant-api/src/cloud-runtime-handler.test.ts`
- Create: `cloudfunctions/assistant-api/src/index.ts`
- Create: `cloudfunctions/assistant-api/src/index.test.ts`
- Create: `cloudfunctions/assistant-api/src/deploy-index.ts`
- Create: `cloudfunctions/assistant-api/src/deploy-index.test.ts`
- Create: `scripts/start-local-assistant.mjs`
- Modify: `scripts/build-cloudfunction-deploy.mjs`
- Modify: `package.json`
- Modify: `cloudbaserc.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Public actions: `getAssistantConversation`, `sendAssistantMessage`.
- Cloud composition uses wx-server-sdk for trusted identity/database and `@cloudbase/node-sdk` only to obtain `app.ai().createModel(providerId)`.

- [ ] **Step 1: Scaffold the function and install the approved CloudBase SDK**

Pin the approved SDK exactly:

```powershell
pnpm.cmd add --filter @fitness/assistant-api @cloudbase/node-sdk@3.18.3 --save-exact
```

Declare workspace dependencies on agent/application/contracts/domain/persistence/providers plus `wx-server-sdk`; keep nutrition fixtures dev-only and reachable only through dynamic import from the local runtime entry.

- [ ] **Step 2: Write failing handler/runtime/build tests**

Tests must prove unauthenticated rejection, client userId rejection by contract, trusted identity binding, same-key replay, conversation busy/version conflict, exactly one Agent creation, fixed public errors, missing Provider/model/env fail closed, `providerId=cloudbase` with both a Hunyuan model ID and `deepseek-v4-flash`, custom DeepSeek Provider ID pass-through, cloud-only entry not importing fixture/local modules, and deployment artifact containing no `FITNESS_LOCAL_USER_ID` or fixture sentinel.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
pnpm.cmd test -- cloudfunctions/assistant-api/src
```

Expected: FAIL because the function does not exist.

- [ ] **Step 4: Implement the handler orchestration**

For `sendAssistantMessage`:

1. `beginTurn`.
2. Return stored result for replay.
3. If validated, invoke Agent with the authoritative command path and zero model calls.
4. If received, invoke Agent with persisted messages + current message, safe summary, and `authorizeCommand` callback.
5. Execute toolbox through the user-bound command service with domain key `assistant-domain-${turnId}`.
6. Finalize every safe result, including Provider/model/command failures.
7. Map unexpected errors to `internal_error` without persisting raw error text.

- [ ] **Step 5: Implement local and cloud composition roots**

Local mode uses an InMemory repository, existing explicit nutrition fixtures, and a deterministic model fixture. Cloud mode requires all three environment values, initializes:

```ts
const model = tcb.init({ env: environmentId }).ai().createModel(providerId);
```

and passes `modelName` only to `generateText`. There is no default model/provider and no fallback list.

- [ ] **Step 6: Add build/deploy scripts and CloudBase configuration**

Add root scripts:

```json
{
  "dev:assistant": "node scripts/start-local-assistant.mjs",
  "dry-run:assistant": "pnpm --filter @fitness/assistant-api build && pnpm --filter @fitness/assistant-api dry-run",
  "smoke:assistant": "pnpm --filter @fitness/assistant-api build && vitest run --config vitest.assistant-smoke.config.ts"
}
```

Add `assistant-api` to the deploy allowlist and `cloudbaserc.json` with Nodejs20.19, `installDependency: false`, handler `index.main`, and timeout `120` seconds. The 120-second function budget covers a worst-case initial generation with one 20-second transport retry, one repaired generation with one 20-second transport retry, transaction/finalization time, and a bounded response margin; each Provider transport attempt still enforces its own 20-second timeout. Keep existing function entries unchanged.

- [ ] **Step 7: Run focused tests and build checks**

```powershell
pnpm.cmd test -- cloudfunctions/assistant-api/src tests/e2e/cloudfunction-deploy-artifact.test.ts
pnpm.cmd --filter @fitness/assistant-api typecheck
pnpm.cmd --filter @fitness/assistant-api build
pnpm.cmd dry-run:assistant
```

Expected: all exit 0 and both local/deploy bundles are generated.

- [ ] **Step 8: Commit**

```powershell
git add cloudfunctions/assistant-api scripts package.json cloudbaserc.json pnpm-lock.yaml tests/e2e/cloudfunction-deploy-artifact.test.ts
git commit -m "feat: expose authenticated assistant API"
```

---

### Task 8: Native Mini Program Assistant Experience

**Files:**
- Create: `miniprogram/services/assistant-api.ts`
- Create: `miniprogram/services/assistant-api.test.ts`
- Create: `miniprogram/pages/assistant/pending-command.ts`
- Create: `miniprogram/pages/assistant/pending-command.test.ts`
- Create: `miniprogram/pages/assistant/view-model.ts`
- Create: `miniprogram/pages/assistant/view-model.test.ts`
- Create: `miniprogram/pages/assistant/index.ts`
- Create: `miniprogram/pages/assistant/index.test.ts`
- Create: `miniprogram/pages/assistant/index.wxml`
- Create: `miniprogram/pages/assistant/index.wxss`
- Create: `miniprogram/pages/assistant/index.json`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/planning-setup/index.ts`
- Modify: `miniprogram/pages/planning-setup/index.wxml`
- Modify: `miniprogram/pages/meal-execution/index.ts`
- Modify: `miniprogram/pages/meal-execution/index.wxml`
- Modify: `miniprogram/build.test.ts`

**Interfaces:**
- Sends one `sendAssistantMessage` request and stores/replays its exact pending envelope.
- Navigates to existing structured planning/meal pages on fixed recovery actions.

- [ ] **Step 1: Read and apply the `ui-ux-pro-max` skill before UI edits**

Use the skill only to check native mobile spacing, readability, disabled/loading states, focus labels, touch target size, and accessible contrast. Do not introduce a frontend framework, icon dependency, generated bitmap, or design-system package.

- [ ] **Step 2: Write failing service/view-model/controller tests**

Cover strict response parsing, cloud function name `assistant-api`, local port `3001`, pending envelope round-trip, page-load recovery, 12-message rendering, duplicate-send prevention, 2000-character cap, fixed capability examples, success refresh, and every recovery action. Assert no model/provider selector or arbitrary response HTML/Markdown rendering exists.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
pnpm.cmd test -- miniprogram/services/assistant-api.test.ts miniprogram/pages/assistant
```

Expected: FAIL because the client/page does not exist.

- [ ] **Step 4: Implement the strict client and pending persistence**

Use `wx.cloud.callFunction({ name: 'assistant-api' })` in cloud mode and `http://127.0.0.1:3001/` in local mode. Save `{ expectedVersion, idempotencyKey, message }` before sending; clear it only after a parsed terminal response. On page load, compare local pending state with server pending state and replay the exact envelope when they match.

- [ ] **Step 5: Implement the native page**

The header copy is fixed to “受限计划助手”. Display three non-click-to-submit examples, ISO date and multiplier instructions, fixed estimate/safety copy, message list, text input, send button, loading state, and buttons to the planning and meal pages. Render content as plain text only.

- [ ] **Step 6: Run focused tests, mini-program typecheck, and build**

```powershell
pnpm.cmd test -- miniprogram/services/assistant-api.test.ts miniprogram/pages/assistant miniprogram/build.test.ts
pnpm.cmd exec tsc -p miniprogram/tsconfig.json --noEmit
pnpm.cmd build:miniprogram
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```powershell
git add miniprogram
git commit -m "feat: add bounded assistant mini program page"
```

---

### Task 9: End-to-End Recovery, Isolation, and Process Smoke

**Files:**
- Create: `tests/e2e/assistant-workflow.test.ts`
- Create: `tests/smoke/assistant-api.smoke.test.ts`
- Create: `vitest.assistant-smoke.config.ts`
- Modify: `package.json`

**Interfaces:**
- Uses the real authenticated assistant handler, one InMemory planning repository, fixed reviewed planning fixtures, and deterministic model backend.
- Starts the actual local assistant function process for smoke verification.

- [ ] **Step 1: Write the failing E2E and smoke scenarios**

The E2E timeline must prove:

1. complete planning setup and generate a weekly meal plan through public services;
2. move one future training session and independently verify affected dates and weekly net-training conservation;
3. replace one future meal by exact reviewed Chinese dish name and independently recompute displayed nutrients;
4. resize one future meal and independently recompute every ingredient gram/nutrient plus weekly inventory usage;
5. locked dates remain pending-confirmation on training change and are never overwritten silently;
6. same-key response-loss replay does not grow conversation, training, meal, job, or receipt counts twice;
7. malformed output repairs once, second failure makes zero planning writes;
8. Provider unavailable leaves planning-api structure and deterministic resize action usable;
9. two users cannot observe each other’s messages, summary, pending turn, receipt, or planning versions.

The process smoke sends `getAssistantConversation`, one deterministic clarify request, and one provider-unavailable/fallback-safe request through the real local function HTTP process.

- [ ] **Step 2: Run focused E2E/smoke and verify RED**

```powershell
pnpm.cmd test -- tests/e2e/assistant-workflow.test.ts
pnpm.cmd smoke:assistant
```

Expected: one or both fail until orchestration and smoke wiring are complete.

- [ ] **Step 3: Add only the fixture/wiring needed by the tests**

Keep the deterministic model fixture in local-only runtime code and existing `test_fixture` nutrition records. Do not add production fallback data, user-like health fixtures, or a network call.

- [ ] **Step 4: Run focused E2E/smoke and verify GREEN twice**

Run the Step 2 commands twice. Expected: both consecutive runs exit 0, proving no leaked local process or shared state.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/assistant-workflow.test.ts tests/smoke/assistant-api.smoke.test.ts vitest.assistant-smoke.config.ts package.json
git commit -m "test: complete bounded assistant workflow"
```

---

### Task 10: Deployment Documentation, Full Audit, and Phase Completion

**Files:**
- Create: `docs/cloudbase/phase-6-bounded-assistant-deployment.md`
- Modify: `README.md`
- Modify: `DEVELOPMENT_PROGRESS.md`
- Verify: `AGENTS.md`
- Verify: `docs/superpowers/specs/2026-08-19-phase-6-bounded-single-agent-design.md`

**Interfaces:**
- Documents exact local commands, CloudBase configuration, Hunyuan/DeepSeek selection, no-fallback rule, deployment/rollback, external gates, and phase-six evidence.

- [ ] **Step 1: Write deployment and rollback documentation**

Document:

- local `dev:api`, `dev:assistant`, page path, dry-run, and smoke commands;
- required environment variable names without example secrets/environment IDs;
- CloudBase managed Hunyuan/DeepSeek and custom DeepSeek Provider configuration;
- requirement to use exact model IDs enabled in the target environment;
- schema-v7 forward deployment and v7-aware rollback sequence;
- two-account session isolation, IAM, logs, cost, model content marking, IDE, and device checklists;
- explicit statement that local fixtures do not prove production readiness.

- [ ] **Step 2: Run targeted secret and boundary scans before full gates**

```powershell
rg -n "BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|SECRET_ACCESS_KEY|api[_-]?key\s*[:=]\s*['\"][^'\"]+|cloud://[^\s'\"]+|FITNESS_LOCAL_USER_ID" --glob '!pnpm-lock.yaml' --glob '!.pnpm-store/**' .
rg -n "from ['\"](@cloudbase|wx-server-sdk|@langchain)|database\(|collection\(|\bwx\." packages/domain packages/calculation
rg -n "createReactAgent|createAgent|multi.?agent|toolChoice|tools:" packages/agent cloudfunctions/assistant-api
```

Expected: secret hits are absent or documented synthetic/test sentinels; domain/calculation and multi-Agent/tool scans have no forbidden production matches.

- [ ] **Step 3: Run the complete fresh verification gate in order**

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
git diff --check
```

Expected: every command exits 0. Record exact test file/test counts and build artifact sizes from this fresh run.

- [ ] **Step 4: Audit all six phase-six acceptance lines against authoritative evidence**

For each checkbox in `DEVELOPMENT_PROGRESS.md`, identify direct implementation files and test names. Confirm specifically:

1. one compiled LangGraph StateGraph and no multi-Agent runtime;
2. exactly three intents reaching public application commands;
3. strict runtime schema and at most one repair;
4. last 12 messages plus non-sensitive summary and user isolation;
5. forbidden numeric/tool/URL/query/identity/version/allergen bypass outputs fail closed;
6. illegal output, timeout, retry, circuit, fallback, and deterministic-core independence tests.

Do not infer acceptance from a broad green test command without locating the tests.

- [ ] **Step 5: Update README and progress truthfully**

Only after Step 3 and Step 4 pass:

- mark phase 6 `已完成` and check all six lines;
- record implementation commits, fresh command outputs/counts, remaining work, external blockers, and phase 7 as next;
- state that real CloudBase Hunyuan/DeepSeek, custom Provider contracts, model permissions,备案/登记, content labels, two-account cloud isolation, IDE, and device tests remain unverified;
- keep phase 7 `未开始`.

- [ ] **Step 6: Inspect final diff and commit documentation**

```powershell
git status --short --branch
git diff --stat HEAD
git diff --check
git add README.md DEVELOPMENT_PROGRESS.md docs/cloudbase/phase-6-bounded-assistant-deployment.md
git commit -m "docs: complete phase six assistant"
```

Expected: commit contains only final documentation/progress changes; `.pnpm-store/` remains untracked and untouched.

- [ ] **Step 7: Re-run post-commit smoke and inspect clean task scope**

```powershell
pnpm.cmd smoke:api
pnpm.cmd smoke:assistant
git status --short --branch
```

Expected: both smoke suites exit 0; status shows only the pre-existing untracked `.pnpm-store/` and branch-ahead information.

## Plan Completion Criteria

Phase 6 is complete only when all ten tasks are committed on `feat/v1.0`, every approved design and `DEVELOPMENT_PROGRESS.md` acceptance requirement has direct current-state evidence, all fresh commands in Task 10 pass after the final implementation change, and the only unrelated workspace item remains the preserved `.pnpm-store/`. Do not claim real CloudBase AI+, Hunyuan/DeepSeek availability,备案/登记, AI content marking, two-user cloud isolation, WeChat visual/device validation, or production readiness without their external evidence.
