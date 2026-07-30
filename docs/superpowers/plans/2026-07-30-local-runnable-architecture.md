# Fitness Local Runnable Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real WeChat Mini Program → CloudBase-compatible local function → application service → deterministic calculation vertical slice that can be installed, tested, built, started, and inspected locally without a CloudBase account or paid API.

**Architecture:** A pnpm TypeScript workspace enforces one-way dependencies from the mini program and function controller into application, domain, calculation, contracts, and reviewed MET data packages. The local function is exported as a CloudBase event function and run by the official `tcb-ff` framework; `calculation-policy-v2` remains pure, deterministic, source-bound, and fail-closed.

**Tech Stack:** pnpm 9, TypeScript 5.9, Zod 4, Vitest 3, ESLint 9 with typescript-eslint 8, esbuild 0.25, `@cloudbase/functions-framework` 1.6, native WeChat Mini Program TypeScript, CloudBase Node.js 20.19 target.

## Global Constraints

- Serve healthy adults only; automated personalized energy is limited to ages 18–45, BMI `18.5–<24.0`, a completed minimal health-scope confirmation, and all required inputs.
- Use `calculation-policy-v2` exactly: BMR `14.52 × weightKg - 155.88 × sexCode + 565.79`; PAL `1.50 / 1.75 / 2.00`; goal adjustments `0% / -10% / +5%`.
- Training net energy is `(MET - 1) × 3.5 × weightKg / 200 × minutes`; the client never submits MET, and code `02054` resolves only from reviewed 2024 Adult Compendium data.
- Never return automated deficit or surplus values when eligibility fails; return `unsupported_for_personalized_energy` with structured reasons.
- Display energy and BMI as estimates, never as precise or medical-grade values.
- No LLM, vision, nutrition provider, database, storage, real CloudBase environment, environment ID, AppID secret, or paid API is used in Phase 1.
- `domain` imports no Zod, CloudBase SDK, WeChat API, LangGraph, or supplier DTO; `calculation` has no network, database, clock, randomness, or logging side effects.
- TypeScript strict mode is mandatory; avoid unjustified `any`, non-null assertions, and type escapes.
- Do not create unused `agent`, `providers`, database, recipe, or placeholder modules.
- Do not commit generated `.build`, `dist`, `node_modules`, logs, real secrets, real user data, or images.
- Every production behavior follows RED → GREEN → REFACTOR; configuration-only bootstrap files are not production behavior.

---

### Task 1: Bootstrap the workspace and cross-end contracts

**Files:**
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.mjs`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/planning-api.test.ts`
- Create: `packages/contracts/src/planning-api.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `pnpm-lock.yaml` via `pnpm install`

**Interfaces:**
- Consumes: the two allowed actions `health` and `previewDailyEnergy` from the approved design.
- Produces: `planningApiRequestSchema`, `planningApiResponseSchema`, `PreviewDailyEnergyRequest`, `PlanningApiRequest`, and `PlanningApiResponse` for the mini program and function controller.

- [x] **Step 1: Add workspace-only configuration**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.build/
coverage/
logs/
*.log
.env
.env.*
!.env.example
project.private.config.json
```

Create `.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
```

Create `package.json`:

```json
{
  "name": "fitness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=20 <23"
  },
  "scripts": {
    "build": "pnpm -r --if-present build",
    "lint": "eslint .",
    "test": "vitest run",
    "typecheck": "pnpm -r --if-present typecheck"
  },
  "devDependencies": {
    "@eslint/js": "^9.32.0",
    "@types/node": "^22.17.0",
    "eslint": "^9.32.0",
    "typescript": "^5.9.2",
    "typescript-eslint": "^8.38.0",
    "vitest": "^3.2.4"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - data/*
  - cloudfunctions/*
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'data/**/*.test.ts',
      'cloudfunctions/**/*.test.ts',
      'miniprogram/**/*.test.ts'
    ],
    exclude: ['tests/smoke/**'],
    passWithNoTests: false,
  },
});
```

Create root `tsconfig.json` so root Vitest configuration files participate in type-aware linting:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["*.ts"]
}
```

Create `eslint.config.mjs`:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '.build/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDirectory,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
```

- [x] **Step 2: Add the contracts package manifest and install dependencies**

Create `packages/contracts/package.json`:

```json
{
  "name": "@fitness/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

Create `packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

Run:

```powershell
pnpm.cmd install
```

Expected: exit `0`, `pnpm-lock.yaml` is created, and no lifecycle script requests secrets or external credentials.

- [x] **Step 3: Write the failing contract tests**

Create `packages/contracts/src/planning-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planningApiRequestSchema, planningApiResponseSchema } from './planning-api';

const supportedRequest = {
  action: 'previewDailyEnergy',
  payload: {
    ageYears: 30,
    sexCode: 0,
    heightCm: 175,
    weightKg: 70,
    healthScopeConfirmed: true,
    nonTrainingActivity: 'light',
    goal: 'maintain',
    training: { sessionCode: '02054', durationMinutes: 60 }
  }
} as const;

describe('planning API contracts', () => {
  it('accepts the two whitelisted actions', () => {
    expect(planningApiRequestSchema.parse({ action: 'health' })).toEqual({ action: 'health' });
    expect(planningApiRequestSchema.parse(supportedRequest)).toEqual(supportedRequest);
  });

  it('rejects client supplied MET and malformed numbers', () => {
    expect(() => planningApiRequestSchema.parse({
      ...supportedRequest,
      payload: {
        ...supportedRequest.payload,
        weightKg: Number.NaN,
        training: { sessionCode: '02054', durationMinutes: 60, met: 3.5 }
      }
    })).toThrow();
  });

  it('parses a supported response envelope', () => {
    const response = {
      success: true,
      data: {
        kind: 'supported',
        bmi: 22.86,
        estimatedBmrKcal: 1582,
        nonTrainingBaselineKcal: 2373,
        trainingNetKcal: 184,
        estimatedMaintenanceKcal: 2557,
        targetEnergyKcal: 2557,
        policy: {
          policyVersion: 'calculation-policy-v2',
          sourceIds: ['CN-BMR-2023', 'CN-DRI-MACRO-2017', 'MET-COMPENDIUM-2024'],
          applicableAgeRange: { minInclusive: 18, maxInclusive: 45 },
          applicableBmiRange: { minInclusive: 18.5, maxExclusive: 24 },
          rounding: { kcal: 'nearest_whole_half_up', bmi: 'nearest_hundredth_half_up' }
        },
        disclaimer: '初始估算，仅供一般健身与膳食规划参考，不构成医疗建议。'
      }
    } as const;

    expect(planningApiResponseSchema.parse(response)).toEqual(response);
  });
});
```

- [x] **Step 4: Run the tests and verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/contracts/src/planning-api.test.ts
```

Expected: FAIL because `packages/contracts/src/planning-api.ts` does not exist.

- [x] **Step 5: Implement the schemas and inferred types**

Create `packages/contracts/src/planning-api.ts` with strict Zod objects:

```ts
import { z } from 'zod';

const policyMetadataSchema = z.object({
  policyVersion: z.literal('calculation-policy-v2'),
  sourceIds: z.array(z.string().min(1)).min(1),
  applicableAgeRange: z.object({
    minInclusive: z.literal(18),
    maxInclusive: z.literal(45)
  }).strict(),
  applicableBmiRange: z.object({
    minInclusive: z.literal(18.5),
    maxExclusive: z.literal(24)
  }).strict(),
  rounding: z.object({
    kcal: z.literal('nearest_whole_half_up'),
    bmi: z.literal('nearest_hundredth_half_up')
  }).strict()
}).strict();

const previewPayloadSchema = z.object({
  ageYears: z.number().int().min(1).max(120),
  sexCode: z.union([z.literal(0), z.literal(1)]),
  heightCm: z.number().finite().min(100).max(250),
  weightKg: z.number().finite().min(25).max(300),
  healthScopeConfirmed: z.boolean(),
  nonTrainingActivity: z.enum(['light', 'moderate', 'heavy']),
  goal: z.enum(['maintain', 'fat_loss', 'muscle_gain']),
  training: z.object({
    sessionCode: z.string().regex(/^\d{5}$/),
    durationMinutes: z.number().finite().positive().max(300)
  }).strict().optional()
}).strict();

export const planningApiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('health') }).strict(),
  z.object({
    action: z.literal('previewDailyEnergy'),
    payload: previewPayloadSchema
  }).strict()
]);

const unsupportedReasonSchema = z.enum([
  'age_out_of_range',
  'bmi_out_of_range',
  'health_scope_not_confirmed'
]);

const healthDataSchema = z.object({
  kind: z.literal('health'),
  status: z.literal('ok'),
  service: z.literal('planning-api'),
  policyVersion: z.literal('calculation-policy-v2')
}).strict();

const supportedDataSchema = z.object({
  kind: z.literal('supported'),
  bmi: z.number().finite(),
  estimatedBmrKcal: z.number().finite(),
  nonTrainingBaselineKcal: z.number().finite(),
  trainingNetKcal: z.number().finite(),
  estimatedMaintenanceKcal: z.number().finite(),
  targetEnergyKcal: z.number().finite(),
  policy: policyMetadataSchema,
  disclaimer: z.string().min(1)
}).strict();

const unsupportedDataSchema = z.object({
  kind: z.literal('unsupported'),
  code: z.literal('unsupported_for_personalized_energy'),
  reasons: z.array(unsupportedReasonSchema).min(1),
  bmi: z.number().finite(),
  policy: policyMetadataSchema
}).strict();

const successfulDataSchema = z.discriminatedUnion('kind', [
  healthDataSchema,
  supportedDataSchema,
  unsupportedDataSchema
]);

const apiErrorSchema = z.object({
  code: z.enum(['invalid_request', 'unknown_action', 'unknown_training_session', 'internal_error']),
  message: z.string().min(1),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional()
}).strict();

export const planningApiResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: successfulDataSchema }).strict(),
  z.object({ success: z.literal(false), error: apiErrorSchema }).strict()
]);

export type PlanningApiRequest = z.infer<typeof planningApiRequestSchema>;
export type PreviewDailyEnergyRequest = Extract<PlanningApiRequest, { action: 'previewDailyEnergy' }>;
export type PlanningApiResponse = z.infer<typeof planningApiResponseSchema>;
```

Create `packages/contracts/src/index.ts`:

```ts
export * from './planning-api';
```

- [x] **Step 6: Verify GREEN and workspace quality**

Run:

```powershell
pnpm.cmd exec vitest run packages/contracts/src/planning-api.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build
```

Expected: all commands exit `0`; the contract test reports three passing tests.

- [x] **Step 7: Commit the workspace and contracts**

```powershell
git add -- .gitignore .editorconfig package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json vitest.config.ts eslint.config.mjs packages/contracts
git commit -m "feat: add strict planning API contracts"
```

---

### Task 2: Add domain types, policy metadata, eligibility, and rounding

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/daily-energy.ts`
- Create: `packages/domain/src/index.ts`
- Create: `packages/calculation/package.json`
- Create: `packages/calculation/tsconfig.json`
- Create: `packages/calculation/src/policy.ts`
- Create: `packages/calculation/src/eligibility.test.ts`
- Create: `packages/calculation/src/eligibility.ts`
- Create: `packages/calculation/src/rounding.test.ts`
- Create: `packages/calculation/src/rounding.ts`
- Create: `packages/calculation/src/index.ts`

**Interfaces:**
- Consumes: no runtime packages except `@fitness/domain`.
- Produces: `CALCULATION_POLICY_V2`, `evaluateEligibility(input)`, `roundHalfUp(value, decimals)`, and the domain types later consumed by the energy calculator.

- [x] **Step 1: Add domain and calculation manifests**

Create `packages/domain/package.json`:

```json
{
  "name": "@fitness/domain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Create `packages/domain/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/calculation/package.json`:

```json
{
  "name": "@fitness/calculation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fitness/domain": "workspace:*"
  }
}
```

Create `packages/calculation/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

- [x] **Step 2: Define dependency-free domain types**

Create `packages/domain/src/daily-energy.ts`:

```ts
export type SexCode = 0 | 1;
export type NonTrainingActivity = 'light' | 'moderate' | 'heavy';
export type FitnessGoal = 'maintain' | 'fat_loss' | 'muscle_gain';
export type UnsupportedReason =
  | 'age_out_of_range'
  | 'bmi_out_of_range'
  | 'health_scope_not_confirmed';

export interface EligibilityInput {
  readonly ageYears: number;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly healthScopeConfirmed: boolean;
}

export interface ReviewedTrainingSession {
  readonly code: string;
  readonly met: number;
  readonly sourceId: 'MET-COMPENDIUM-2024';
  readonly datasetVersion: string;
  readonly reviewedAt: string;
  readonly description: string;
}

export interface DailyEnergyCommand extends EligibilityInput {
  readonly sexCode: SexCode;
  readonly nonTrainingActivity: NonTrainingActivity;
  readonly goal: FitnessGoal;
  readonly training?: {
    readonly session: ReviewedTrainingSession;
    readonly durationMinutes: number;
  };
}

export interface PolicyMetadata {
  readonly policyVersion: 'calculation-policy-v2';
  readonly sourceIds: string[];
  readonly applicableAgeRange: { readonly minInclusive: 18; readonly maxInclusive: 45 };
  readonly applicableBmiRange: { readonly minInclusive: 18.5; readonly maxExclusive: 24 };
  readonly rounding: {
    readonly kcal: 'nearest_whole_half_up';
    readonly bmi: 'nearest_hundredth_half_up';
  };
}

export type DailyEnergyResult =
  | {
      readonly kind: 'supported';
      readonly bmi: number;
      readonly estimatedBmrKcal: number;
      readonly nonTrainingBaselineKcal: number;
      readonly trainingNetKcal: number;
      readonly estimatedMaintenanceKcal: number;
      readonly targetEnergyKcal: number;
      readonly policy: PolicyMetadata;
      readonly disclaimer: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly code: 'unsupported_for_personalized_energy';
      readonly reasons: UnsupportedReason[];
      readonly bmi: number;
      readonly policy: PolicyMetadata;
    };
```

Create `packages/domain/src/index.ts`:

```ts
export * from './daily-energy';
```

- [x] **Step 3: Write failing eligibility and rounding tests**

Create `packages/calculation/src/eligibility.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateEligibility } from './eligibility';

const base = { heightCm: 200, weightKg: 80, healthScopeConfirmed: true };

describe('calculation-policy-v2 eligibility', () => {
  it.each([18, 45])('accepts age boundary %s', (ageYears) => {
    expect(evaluateEligibility({ ...base, ageYears, weightKg: 80 }).reasons).not.toContain('age_out_of_range');
  });

  it.each([17, 46])('rejects age %s', (ageYears) => {
    expect(evaluateEligibility({ ...base, ageYears, weightKg: 80 }).reasons).toContain('age_out_of_range');
  });

  it('accepts BMI 18.5 and rejects raw BMI 24.0', () => {
    expect(evaluateEligibility({ ...base, ageYears: 30, weightKg: 74 }).reasons).not.toContain('bmi_out_of_range');
    expect(evaluateEligibility({ ...base, ageYears: 30, weightKg: 96 }).reasons).toContain('bmi_out_of_range');
  });

  it('requires the health scope confirmation', () => {
    expect(evaluateEligibility({ ...base, ageYears: 30, healthScopeConfirmed: false }).reasons)
      .toContain('health_scope_not_confirmed');
  });
});
```

Create `packages/calculation/src/rounding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { roundHalfUp } from './rounding';

describe('roundHalfUp', () => {
  it('rounds non-negative display values half up at an explicit precision', () => {
    expect(roundHalfUp(2556.5, 0)).toBe(2557);
    expect(roundHalfUp(22.855, 2)).toBe(22.86);
  });
});
```

- [x] **Step 4: Verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/calculation/src/eligibility.test.ts packages/calculation/src/rounding.test.ts
```

Expected: FAIL because `eligibility.ts` and `rounding.ts` do not exist.

- [x] **Step 5: Implement policy metadata, raw-BMI eligibility, and display rounding**

Create `packages/calculation/src/policy.ts`:

```ts
export const CALCULATION_POLICY_V2 = Object.freeze({
  policyVersion: 'calculation-policy-v2' as const,
  sourceIds: ['CN-BMR-2023', 'CN-DRI-MACRO-2017'] as const,
  applicableAgeRange: { minInclusive: 18 as const, maxInclusive: 45 as const },
  applicableBmiRange: { minInclusive: 18.5 as const, maxExclusive: 24 as const },
  bmr: { weightCoefficient: 14.52, sexCoefficient: -155.88, intercept: 565.79 },
  pal: { light: 1.5, moderate: 1.75, heavy: 2 },
  goalAdjustment: { maintain: 0, fat_loss: -0.1, muscle_gain: 0.05 },
  effectiveDate: '2026-07-30',
  reviewedAt: '2026-07-30',
  rounding: {
    kcal: 'nearest_whole_half_up' as const,
    bmi: 'nearest_hundredth_half_up' as const
  }
});
```

Create `packages/calculation/src/eligibility.ts`:

```ts
import type { EligibilityInput, UnsupportedReason } from '@fitness/domain';
import { CALCULATION_POLICY_V2 } from './policy';

export interface EligibilityResult {
  readonly bmi: number;
  readonly reasons: UnsupportedReason[];
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const heightM = input.heightCm / 100;
  const bmi = input.weightKg / (heightM * heightM);
  const reasons: UnsupportedReason[] = [];
  const ageRange = CALCULATION_POLICY_V2.applicableAgeRange;
  const bmiRange = CALCULATION_POLICY_V2.applicableBmiRange;

  if (input.ageYears < ageRange.minInclusive || input.ageYears > ageRange.maxInclusive) {
    reasons.push('age_out_of_range');
  }
  if (bmi < bmiRange.minInclusive || bmi >= bmiRange.maxExclusive) {
    reasons.push('bmi_out_of_range');
  }
  if (!input.healthScopeConfirmed) {
    reasons.push('health_scope_not_confirmed');
  }

  return { bmi, reasons };
}
```

Create `packages/calculation/src/rounding.ts`:

```ts
export function roundHalfUp(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new RangeError('roundHalfUp expects a finite non-negative value and non-negative integer precision');
  }
  const factor = 10 ** decimalPlaces;
  return Math.floor(value * factor + 0.5 + Number.EPSILON) / factor;
}
```

Create `packages/calculation/src/index.ts`:

```ts
export * from './eligibility';
export * from './policy';
export * from './rounding';
```

- [x] **Step 6: Verify GREEN**

Run:

```powershell
pnpm.cmd exec vitest run packages/calculation/src/eligibility.test.ts packages/calculation/src/rounding.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build
```

Expected: all commands exit `0`; six parameterized eligibility assertions and two rounding assertions pass.

- [x] **Step 7: Commit domain and policy foundations**

```powershell
git add -- packages/domain packages/calculation
git commit -m "feat: add calculation policy eligibility"
```

---

### Task 3: Add reviewed MET data and deterministic daily energy calculation

**Files:**
- Create: `data/met-sessions/package.json`
- Create: `data/met-sessions/tsconfig.json`
- Create: `data/met-sessions/src/reviewed-met-sessions.test.ts`
- Create: `data/met-sessions/src/reviewed-met-sessions.ts`
- Create: `data/met-sessions/src/index.ts`
- Modify: `packages/calculation/package.json`
- Create: `packages/calculation/src/calculate-daily-energy.test.ts`
- Create: `packages/calculation/src/calculate-daily-energy.ts`
- Create: `packages/calculation/src/reviewed-training-session.ts`
- Modify: `packages/calculation/src/index.ts`

**Interfaces:**
- Consumes: `DailyEnergyCommand`, `DailyEnergyResult`, `CALCULATION_POLICY_V2`, and reviewed dataset code `02054`.
- Produces: `findReviewedTrainingSession(code): ReviewedTrainingSession | undefined` and `calculateDailyEnergy(command): DailyEnergyResult`.

- [x] **Step 1: Add the reviewed data package and its failing integrity test**

Create `data/met-sessions/package.json`:

```json
{
  "name": "@fitness/met-sessions",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Create `data/met-sessions/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

Create `data/met-sessions/src/reviewed-met-sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REVIEWED_MET_DATASET } from './reviewed-met-sessions';

describe('reviewed MET dataset', () => {
  it('preserves the source chain for session 02054', () => {
    expect(REVIEWED_MET_DATASET).toMatchObject({
      datasetVersion: '2024.1',
      sourceId: 'MET-COMPENDIUM-2024',
      reviewedAt: '2026-07-30'
    });
    expect(REVIEWED_MET_DATASET.sessions).toEqual([
      {
        code: '02054',
        met: 3.5,
        description: 'Resistance (weight) training, multiple exercises, 8-15 reps at varied resistance'
      }
    ]);
  });
});
```

Run:

```powershell
pnpm.cmd exec vitest run data/met-sessions/src/reviewed-met-sessions.test.ts
```

Expected: FAIL because the reviewed dataset module does not exist.

- [x] **Step 2: Implement the single reviewed session record**

Create `data/met-sessions/src/reviewed-met-sessions.ts`:

```ts
export const REVIEWED_MET_DATASET = Object.freeze({
  datasetVersion: '2024.1',
  sourceId: 'MET-COMPENDIUM-2024' as const,
  reviewedAt: '2026-07-30',
  sessions: [
    {
      code: '02054',
      met: 3.5,
      description: 'Resistance (weight) training, multiple exercises, 8-15 reps at varied resistance'
    }
  ] as const
});
```

Create `data/met-sessions/src/index.ts`:

```ts
export * from './reviewed-met-sessions';
```

Run the data test again. Expected: PASS.

- [x] **Step 3: Write failing daily energy tests**

Add `"@fitness/met-sessions": "workspace:*"` to the calculation package dependencies.

Create `packages/calculation/src/calculate-daily-energy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { calculateDailyEnergy } from './calculate-daily-energy';
import { findReviewedTrainingSession } from './reviewed-training-session';

const base = {
  ageYears: 30,
  sexCode: 0 as const,
  heightCm: 175,
  weightKg: 70,
  healthScopeConfirmed: true,
  nonTrainingActivity: 'light' as const,
  goal: 'maintain' as const
};

describe('calculateDailyEnergy', () => {
  it('separates PAL from reviewed training energy and preserves traceability', () => {
    const session = findReviewedTrainingSession('02054');
    expect(session).toBeDefined();
    if (session === undefined) return;

    const result = calculateDailyEnergy({
      ...base,
      training: { session, durationMinutes: 60 }
    });

    expect(result).toMatchObject({
      kind: 'supported',
      bmi: 22.86,
      estimatedBmrKcal: 1582,
      nonTrainingBaselineKcal: 2373,
      trainingNetKcal: 184,
      estimatedMaintenanceKcal: 2557,
      targetEnergyKcal: 2557
    });
    if (result.kind === 'supported') {
      expect(result.policy.sourceIds).toContain('MET-COMPENDIUM-2024');
    }
  });

  it.each([
    ['maintain', 2373],
    ['fat_loss', 2136],
    ['muscle_gain', 2492]
  ] as const)('applies the fixed %s adjustment without widening', (goal, expected) => {
    const result = calculateDailyEnergy({ ...base, goal });
    expect(result.kind).toBe('supported');
    if (result.kind === 'supported') expect(result.targetEnergyKcal).toBe(expected);
  });

  it('uses the user-provided sex code and all non-training PAL branches', () => {
    const female = calculateDailyEnergy({ ...base, sexCode: 1 });
    expect(female.kind).toBe('supported');
    if (female.kind === 'supported') expect(female.estimatedBmrKcal).toBe(1426);

    const moderate = calculateDailyEnergy({ ...base, nonTrainingActivity: 'moderate' });
    const heavy = calculateDailyEnergy({ ...base, nonTrainingActivity: 'heavy' });
    if (moderate.kind === 'supported') expect(moderate.nonTrainingBaselineKcal).toBe(2769);
    if (heavy.kind === 'supported') expect(heavy.nonTrainingBaselineKcal).toBe(3164);
  });

  it('adds reviewed training exactly once on top of the non-training baseline', () => {
    const session = findReviewedTrainingSession('02054');
    if (session === undefined) throw new Error('reviewed fixture 02054 is missing');
    const withoutTraining = calculateDailyEnergy(base);
    const withTraining = calculateDailyEnergy({
      ...base,
      training: { session, durationMinutes: 60 }
    });
    if (withoutTraining.kind === 'supported' && withTraining.kind === 'supported') {
      expect(withTraining.estimatedMaintenanceKcal - withoutTraining.estimatedMaintenanceKcal).toBe(184);
    }
  });

  it('returns no target energy when BMI is 24.0', () => {
    const result = calculateDailyEnergy({ ...base, heightCm: 200, weightKg: 96 });
    expect(result).toEqual(expect.objectContaining({
      kind: 'unsupported',
      code: 'unsupported_for_personalized_energy',
      reasons: ['bmi_out_of_range']
    }));
    expect(result).not.toHaveProperty('targetEnergyKcal');
  });
});
```

- [x] **Step 4: Verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/calculation/src/calculate-daily-energy.test.ts
```

Expected: FAIL because the calculator and reviewed-session resolver do not exist.

- [x] **Step 5: Implement source resolution and the deterministic calculation**

Create `packages/calculation/src/reviewed-training-session.ts`:

```ts
import { REVIEWED_MET_DATASET } from '@fitness/met-sessions';
import type { ReviewedTrainingSession } from '@fitness/domain';

export function findReviewedTrainingSession(code: string): ReviewedTrainingSession | undefined {
  const record = REVIEWED_MET_DATASET.sessions.find((session) => session.code === code);
  if (record === undefined) return undefined;
  return {
    ...record,
    sourceId: REVIEWED_MET_DATASET.sourceId,
    datasetVersion: REVIEWED_MET_DATASET.datasetVersion,
    reviewedAt: REVIEWED_MET_DATASET.reviewedAt
  };
}
```

Create `packages/calculation/src/calculate-daily-energy.ts`:

```ts
import type { DailyEnergyCommand, DailyEnergyResult, PolicyMetadata } from '@fitness/domain';
import { evaluateEligibility } from './eligibility';
import { CALCULATION_POLICY_V2 } from './policy';
import { roundHalfUp } from './rounding';

const DISCLAIMER = '初始估算，仅供一般健身与膳食规划参考，不构成医疗建议。';

function policyMetadata(extraSourceIds: readonly string[] = []): PolicyMetadata {
  return {
    policyVersion: CALCULATION_POLICY_V2.policyVersion,
    sourceIds: [...CALCULATION_POLICY_V2.sourceIds, ...extraSourceIds],
    applicableAgeRange: CALCULATION_POLICY_V2.applicableAgeRange,
    applicableBmiRange: CALCULATION_POLICY_V2.applicableBmiRange,
    rounding: CALCULATION_POLICY_V2.rounding
  };
}

export function calculateDailyEnergy(command: DailyEnergyCommand): DailyEnergyResult {
  const eligibility = evaluateEligibility(command);
  const bmi = roundHalfUp(eligibility.bmi, 2);
  if (eligibility.reasons.length > 0) {
    return {
      kind: 'unsupported',
      code: 'unsupported_for_personalized_energy',
      reasons: eligibility.reasons,
      bmi,
      policy: policyMetadata()
    };
  }

  const policy = CALCULATION_POLICY_V2;
  const bmr = policy.bmr.weightCoefficient * command.weightKg
    + policy.bmr.sexCoefficient * command.sexCode
    + policy.bmr.intercept;
  const baseline = bmr * policy.pal[command.nonTrainingActivity];
  const trainingNet = command.training === undefined
    ? 0
    : (command.training.session.met - 1) * 3.5 * command.weightKg / 200
      * command.training.durationMinutes;
  const maintenance = baseline + trainingNet;
  const target = maintenance * (1 + policy.goalAdjustment[command.goal]);
  const extraSourceIds = command.training === undefined ? [] : [command.training.session.sourceId];

  return {
    kind: 'supported',
    bmi,
    estimatedBmrKcal: roundHalfUp(bmr, 0),
    nonTrainingBaselineKcal: roundHalfUp(baseline, 0),
    trainingNetKcal: roundHalfUp(trainingNet, 0),
    estimatedMaintenanceKcal: roundHalfUp(maintenance, 0),
    targetEnergyKcal: roundHalfUp(target, 0),
    policy: policyMetadata(extraSourceIds),
    disclaimer: DISCLAIMER
  };
}
```

Export both modules from `packages/calculation/src/index.ts`.

- [x] **Step 6: Verify GREEN and all calculation invariants**

Run:

```powershell
pnpm.cmd exec vitest run data/met-sessions/src/reviewed-met-sessions.test.ts packages/calculation/src
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build
```

Expected: all commands exit `0`; expected supported results are `1582 / 2373 / 184 / 2557`, BMI `24.0` is unsupported, and no test uses a client-supplied MET.

- [x] **Step 7: Commit reviewed data and calculation**

```powershell
git add -- data/met-sessions packages/calculation
git commit -m "feat: calculate traceable daily energy"
```

---

### Task 4: Add the application use case

**Files:**
- Create: `packages/application/package.json`
- Create: `packages/application/tsconfig.json`
- Create: `packages/application/src/preview-daily-energy.test.ts`
- Create: `packages/application/src/preview-daily-energy.ts`
- Create: `packages/application/src/index.ts`

**Interfaces:**
- Consumes: `PreviewDailyEnergyRequest['payload']`, `findReviewedTrainingSession`, and `calculateDailyEnergy`.
- Produces: `previewDailyEnergy(payload): DailyEnergyResult` and `UnknownTrainingSessionError`.

- [x] **Step 1: Add the application package manifest**

Create `packages/application/package.json`:

```json
{
  "name": "@fitness/application",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fitness/calculation": "workspace:*",
    "@fitness/contracts": "workspace:*",
    "@fitness/domain": "workspace:*"
  }
}
```

Create `packages/application/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

- [x] **Step 2: Write the failing application tests**

Create `packages/application/src/preview-daily-energy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UnknownTrainingSessionError, previewDailyEnergy } from './preview-daily-energy';

const payload = {
  ageYears: 30,
  sexCode: 0 as const,
  heightCm: 175,
  weightKg: 70,
  healthScopeConfirmed: true,
  nonTrainingActivity: 'light' as const,
  goal: 'maintain' as const,
  training: { sessionCode: '02054', durationMinutes: 60 }
};

describe('previewDailyEnergy', () => {
  it('maps a reviewed training code before calculation', () => {
    expect(previewDailyEnergy(payload)).toEqual(expect.objectContaining({
      kind: 'supported',
      trainingNetKcal: 184,
      targetEnergyKcal: 2557
    }));
  });

  it('fails closed for an unreviewed training code', () => {
    expect(() => previewDailyEnergy({
      ...payload,
      training: { sessionCode: '99999', durationMinutes: 60 }
    })).toThrow(UnknownTrainingSessionError);
  });
});
```

- [x] **Step 3: Verify RED**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/preview-daily-energy.test.ts
```

Expected: FAIL because the use case does not exist.

- [x] **Step 4: Implement the use case without transport concerns**

Create `packages/application/src/preview-daily-energy.ts`:

```ts
import { calculateDailyEnergy, findReviewedTrainingSession } from '@fitness/calculation';
import type { PreviewDailyEnergyRequest } from '@fitness/contracts';
import type { DailyEnergyResult } from '@fitness/domain';

export class UnknownTrainingSessionError extends Error {
  public readonly code = 'unknown_training_session' as const;

  public constructor(public readonly sessionCode: string) {
    super(`Training session ${sessionCode} is not in the reviewed dataset`);
    this.name = 'UnknownTrainingSessionError';
  }
}

export function previewDailyEnergy(
  payload: PreviewDailyEnergyRequest['payload']
): DailyEnergyResult {
  const { training, ...command } = payload;
  if (training === undefined) return calculateDailyEnergy(command);
  const session = findReviewedTrainingSession(training.sessionCode);
  if (session === undefined) throw new UnknownTrainingSessionError(training.sessionCode);
  return calculateDailyEnergy({
    ...command,
    training: { session, durationMinutes: training.durationMinutes }
  });
}
```

Create `packages/application/src/index.ts`:

```ts
export * from './preview-daily-energy';
```

- [x] **Step 5: Verify GREEN**

Run:

```powershell
pnpm.cmd exec vitest run packages/application/src/preview-daily-energy.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build
```

Expected: all commands exit `0`; both application tests pass.

- [x] **Step 6: Commit the use case**

```powershell
git add -- packages/application
git commit -m "feat: add daily energy preview use case"
```

---

### Task 5: Add the CloudBase-compatible function controller and bundle

**Files:**
- Create: `cloudfunctions/planning-api/package.json`
- Create: `cloudfunctions/planning-api/tsconfig.json`
- Create: `cloudfunctions/planning-api/tsup.config.ts`
- Create: `cloudfunctions/planning-api/src/handler.test.ts`
- Create: `cloudfunctions/planning-api/src/handler.ts`
- Create: `cloudfunctions/planning-api/src/index.test.ts`
- Create: `cloudfunctions/planning-api/src/index.ts`
- Create: `cloudbaserc.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `planningApiRequestSchema`, `previewDailyEnergy`, and `UnknownTrainingSessionError`.
- Produces: `handlePlanningApi(input: unknown): Promise<PlanningApiResponse>` and CloudBase export `main(event: unknown): Promise<PlanningApiResponse>`.

- [x] **Step 1: Add function build and local-run configuration**

Create `cloudfunctions/planning-api/package.json`:

```json
{
  "name": "@fitness/planning-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start:local": "tcb-ff --source=dist/index.js --target=main --logEventContext=false --logHeaderBody=false",
    "dev": "pnpm build && pnpm start:local"
  },
  "dependencies": {
    "@fitness/application": "workspace:*",
    "@fitness/contracts": "workspace:*"
  },
  "devDependencies": {
    "@cloudbase/functions-framework": "^1.6.0",
    "tsup": "^8.5.0"
  }
}
```

Create `cloudfunctions/planning-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tsup.config.ts"]
}
```

Create `cloudfunctions/planning-api/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  noExternal: [/.*/]
});
```

Create `cloudbaserc.json` without an environment ID:

```json
{
  "version": "2.0",
  "functionRoot": "./cloudfunctions",
  "functions": [
    {
      "name": "planning-api",
      "dir": "./cloudfunctions/planning-api/dist",
      "runtime": "Nodejs20.19",
      "handler": "index.main",
      "timeout": 5,
      "installDependency": false
    }
  ]
}
```

Add root scripts:

```json
{
  "dev:api": "pnpm --filter @fitness/planning-api dev",
  "dry-run:api": "pnpm --filter @fitness/planning-api build && pnpm --filter @fitness/planning-api exec tcb-ff --source=dist/index.js --target=main --dry-run"
}
```

- [x] **Step 2: Write failing controller tests**

Create `cloudfunctions/planning-api/src/handler.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { handlePlanningApi } from './handler';

describe('handlePlanningApi', () => {
  it('returns the health response', async () => {
    await expect(handlePlanningApi({ action: 'health' })).resolves.toEqual({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    });
  });

  it('distinguishes unknown actions from invalid requests', async () => {
    await expect(handlePlanningApi({ action: 'dropDatabase' })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'unknown_action' })
    }));
    await expect(handlePlanningApi({ action: 'previewDailyEnergy', payload: {} })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'invalid_request' })
    }));
  });

  it('maps an unreviewed session to a stable fail-closed error', async () => {
    const request = {
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'maintain',
        training: { sessionCode: '99999', durationMinutes: 60 }
      }
    };
    await expect(handlePlanningApi(request)).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'unknown_training_session' })
    }));
  });
});
```

Create `cloudfunctions/planning-api/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { main } from './index';

describe('CloudBase main event adapter', () => {
  it('parses the functions-framework HTTP body', async () => {
    await expect(main({ body: JSON.stringify({ action: 'health' }) })).resolves.toEqual({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    });
  });

  it('maps malformed JSON to invalid_request without a stack', async () => {
    const result = await main({ body: '{not-json' });
    expect(result).toEqual({
      success: false,
      error: { code: 'invalid_request', message: '请求体不是有效 JSON。' }
    });
    expect(JSON.stringify(result)).not.toContain('stack');
  });
});
```

- [x] **Step 3: Verify RED**

Run:

```powershell
pnpm.cmd install
pnpm.cmd exec vitest run cloudfunctions/planning-api/src/handler.test.ts cloudfunctions/planning-api/src/index.test.ts
```

Expected: FAIL because `handler.ts` and `index.ts` do not exist.

- [x] **Step 4: Implement the controller and event normalization**

Create `cloudfunctions/planning-api/src/handler.ts`:

```ts
import { UnknownTrainingSessionError, previewDailyEnergy } from '@fitness/application';
import {
  planningApiRequestSchema,
  type PlanningApiResponse
} from '@fitness/contracts';

const knownActions = new Set(['health', 'previewDailyEnergy']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handlePlanningApi(input: unknown): Promise<PlanningApiResponse> {
  if (isRecord(input) && typeof input.action === 'string' && !knownActions.has(input.action)) {
    return { success: false, error: { code: 'unknown_action', message: '不支持的操作。' } };
  }

  const parsed = planningApiRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'invalid_request',
        message: '请求参数不合法。',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    };
  }

  if (parsed.data.action === 'health') {
    return {
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    };
  }

  try {
    return { success: true, data: previewDailyEnergy(parsed.data.payload) };
  } catch (error: unknown) {
    if (error instanceof UnknownTrainingSessionError) {
      return {
        success: false,
        error: { code: error.code, message: '训练会话缺少已审核的 MET 映射。' }
      };
    }
    return { success: false, error: { code: 'internal_error', message: '规划服务暂时不可用。' } };
  }
}
```

Create `cloudfunctions/planning-api/src/index.ts`:

```ts
import type { PlanningApiResponse } from '@fitness/contracts';
import { handlePlanningApi } from './handler';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function main(event: unknown): Promise<PlanningApiResponse> {
  if (!isRecord(event) || !('body' in event)) return handlePlanningApi(event);
  const body = event.body;
  if (typeof body !== 'string') return handlePlanningApi(body);
  try {
    return handlePlanningApi(JSON.parse(body) as unknown);
  } catch {
    return { success: false, error: { code: 'invalid_request', message: '请求体不是有效 JSON。' } };
  }
}
```

- [x] **Step 5: Verify GREEN, bundle loading, and no sensitive request logging**

Run:

```powershell
pnpm.cmd exec vitest run cloudfunctions/planning-api/src
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build
pnpm.cmd dry-run:api
```

Expected: all commands exit `0`; `tcb-ff --dry-run` loads `dist/index.js`; the local start command includes `--logEventContext=false --logHeaderBody=false`.

- [x] **Step 6: Commit the function boundary**

```powershell
git add -- package.json pnpm-lock.yaml cloudbaserc.json cloudfunctions/planning-api
git commit -m "feat: expose planning CloudBase function"
```

---

### Task 6: Add a process-level local API smoke test

**Files:**
- Create: `vitest.smoke.config.ts`
- Create: `tests/smoke/planning-api.smoke.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: built `@fitness/planning-api`, `tcb-ff`, and HTTP port from `PORT`.
- Produces: `pnpm smoke:api`, which proves a real local function process serves health, supported, and unsupported requests.

- [x] **Step 1: Add the smoke command and failing test**

Create `vitest.smoke.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false
  }
});
```

Add the root script:

```json
{
  "smoke:api": "pnpm --filter @fitness/planning-api build && vitest run --config vitest.smoke.config.ts"
}
```

Create the initial RED version of `tests/smoke/planning-api.smoke.test.ts`; it deliberately calls a real port without starting a service:

```ts
import { expect, it } from 'vitest';

it('serves the planning API from a real local process', async () => {
  const response = await fetch('http://127.0.0.1:3131/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'health' })
  });
  expect(response.ok).toBe(true);
});
```

- [x] **Step 2: Verify RED against an intentionally unavailable process**

Ensure port `3131` is unused, then run:

```powershell
pnpm.cmd smoke:api
```

Expected: FAIL with a connection error, proving the smoke test depends on a real HTTP service rather than a direct function import.

- [x] **Step 3: Replace the RED test with the complete process lifecycle and assertions**

Replace `tests/smoke/planning-api.smoke.test.ts` with:

```ts
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const endpoint = 'http://127.0.0.1:3131/';
let service: ChildProcessWithoutNullStreams | undefined;
let output = '';

function startService(): ChildProcessWithoutNullStreams {
  const environment = { ...process.env, PORT: '3131' };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', [
        '/d', '/s', '/c', 'pnpm.cmd', '--filter', '@fitness/planning-api', 'start:local'
      ], { cwd: repositoryRoot, env: environment, shell: false, windowsHide: true })
    : spawn('pnpm', ['--filter', '@fitness/planning-api', 'start:local'], {
        cwd: repositoryRoot,
        env: environment,
        shell: false
      });
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  return child;
}

async function call(request: unknown): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

async function waitUntilHealthy(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (service?.exitCode !== null && service?.exitCode !== undefined) {
      throw new Error(`planning-api exited before readiness\n${output}`);
    }
    try {
      const response = await call({ action: 'health' });
      if (JSON.stringify(response).includes('calculation-policy-v2')) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`planning-api did not become healthy\n${output}`);
}

function stopService(): void {
  if (service?.pid === undefined || service.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(service.pid), '/t', '/f'], { windowsHide: true });
  } else {
    service.kill('SIGTERM');
  }
}

describe('local planning API process', () => {
  beforeAll(async () => {
    service = startService();
    await waitUntilHealthy();
  });

  afterAll(() => {
    stopService();
  });

  it('serves health, supported, and unsupported scenarios', async () => {
    expect(await call({ action: 'health' })).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ status: 'ok', policyVersion: 'calculation-policy-v2' })
    }));

    expect(await call({
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 175,
        weightKg: 70,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'maintain',
        training: { sessionCode: '02054', durationMinutes: 60 }
      }
    })).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ kind: 'supported', targetEnergyKcal: 2557 })
    }));

    const unsupported = await call({
      action: 'previewDailyEnergy',
      payload: {
        ageYears: 30,
        sexCode: 0,
        heightCm: 200,
        weightKg: 96,
        healthScopeConfirmed: true,
        nonTrainingActivity: 'light',
        goal: 'fat_loss'
      }
    });
    expect(unsupported).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        kind: 'unsupported',
        code: 'unsupported_for_personalized_energy',
        reasons: ['bmi_out_of_range']
      })
    }));
    expect(JSON.stringify(unsupported)).not.toContain('targetEnergyKcal');
  });
});
```

This helper records exactly one child PID, never enumerates processes, retries readiness for at most 15 seconds, includes buffered output on startup failure, and terminates only its own process tree.

- [x] **Step 4: Verify GREEN and repeatability**

Run twice:

```powershell
pnpm.cmd smoke:api
pnpm.cmd smoke:api
```

Expected: both runs exit `0`; port `3131` is released between runs; the supported and unsupported assertions pass.

- [x] **Step 5: Commit the smoke harness**

```powershell
git add -- package.json vitest.smoke.config.ts tests/smoke/planning-api.smoke.test.ts
git commit -m "test: verify local planning function process"
```

---

### Task 7: Add the native mini program page and reproducible build

**Files:**
- Create: `miniprogram/tsconfig.json`
- Create: `miniprogram/app.ts`
- Create: `miniprogram/app.json`
- Create: `miniprogram/app.wxss`
- Create: `miniprogram/sitemap.json`
- Create: `miniprogram/services/planning-api.test.ts`
- Create: `miniprogram/services/planning-api.ts`
- Create: `miniprogram/pages/planning-preview/index.ts`
- Create: `miniprogram/pages/planning-preview/index.json`
- Create: `miniprogram/pages/planning-preview/index.wxml`
- Create: `miniprogram/pages/planning-preview/index.wxss`
- Create: `scripts/build-miniprogram.mjs`
- Create: `scripts/open-miniprogram.ps1`
- Create: `project.config.json`
- Create: `project.private.config.example.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `PlanningApiRequest`, `PlanningApiResponse`, and local function `http://127.0.0.1:3000/`.
- Produces: `createPlanningApiClient(transport)`, a native planning preview page, `.build/miniprogram`, `pnpm build:miniprogram`, and `pnpm open:miniprogram`.

- [x] **Step 1: Add mini program tooling and strict typecheck config**

Add root dev dependencies:

```json
{
  "@types/wechat-miniprogram": "^3.4.8",
  "esbuild": "^0.25.8"
}
```

Add scripts:

```json
{
  "build:miniprogram": "node scripts/build-miniprogram.mjs",
  "open:miniprogram": "pnpm build:miniprogram && powershell -ExecutionPolicy Bypass -File scripts/open-miniprogram.ps1",
  "build": "pnpm -r --if-present build && pnpm build:miniprogram",
  "typecheck": "pnpm -r --if-present typecheck && tsc -p miniprogram/tsconfig.json --noEmit"
}
```

Create `miniprogram/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["wechat-miniprogram"],
    "lib": ["ES2022"]
  },
  "include": ["**/*.ts"]
}
```

Run `pnpm.cmd install` and expect exit `0`.

- [x] **Step 2: Write the failing API client tests**

Create `miniprogram/services/planning-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPlanningApiClient } from './planning-api';

describe('mini program planning API client', () => {
  it('validates the response before returning it', async () => {
    const client = createPlanningApiClient(async () => ({
      success: true,
      data: {
        kind: 'health',
        status: 'ok',
        service: 'planning-api',
        policyVersion: 'calculation-policy-v2'
      }
    }));
    await expect(client.call({ action: 'health' })).resolves.toEqual(expect.objectContaining({ success: true }));
  });

  it('rejects an unvalidated server payload', async () => {
    const client = createPlanningApiClient(async () => ({ success: true, calories: 9999 }));
    await expect(client.call({ action: 'health' })).rejects.toThrow('规划服务返回了无法识别的数据');
  });
});
```

Run:

```powershell
pnpm.cmd exec vitest run miniprogram/services/planning-api.test.ts
```

Expected: FAIL because the API client does not exist.

- [x] **Step 3: Implement a transport-injected, response-validating client**

Create `miniprogram/services/planning-api.ts`:

```ts
import {
  planningApiResponseSchema,
  type PlanningApiRequest,
  type PlanningApiResponse
} from '@fitness/contracts';

export type PlanningTransport = (request: PlanningApiRequest) => Promise<unknown>;

export function createPlanningApiClient(transport: PlanningTransport) {
  return {
    async call(request: PlanningApiRequest): Promise<PlanningApiResponse> {
      const parsed = planningApiResponseSchema.safeParse(await transport(request));
      if (!parsed.success) throw new Error('规划服务返回了无法识别的数据。');
      return parsed.data;
    }
  };
}

const localTransport: PlanningTransport = (request) => new Promise((resolve, reject) => {
  wx.request({
    url: 'http://127.0.0.1:3000/',
    method: 'POST',
    data: request,
    timeout: 10_000,
    success: (response) => resolve(response.data),
    fail: () => reject(new Error('无法连接本地规划服务，请先运行 pnpm dev:api。'))
  });
});

export const planningApiClient = createPlanningApiClient(localTransport);
```

Run the client tests again. Expected: PASS.

- [x] **Step 4: Implement the native page without duplicating calculation constants**

Create `app.ts` with `App({})`, `app.json` with page `pages/planning-preview/index`, a plain global stylesheet, and a sitemap allowing the page.

Create `miniprogram/app.ts`:

```ts
App({});
```

Create `miniprogram/app.json`:

```json
{
  "pages": ["pages/planning-preview/index"],
  "window": {
    "navigationBarTitleText": "Fitness 规划预览",
    "navigationBarBackgroundColor": "#f4f7f2",
    "navigationBarTextStyle": "black",
    "backgroundColor": "#f4f7f2"
  },
  "sitemapLocation": "sitemap.json"
}
```

Create `miniprogram/app.wxss`:

```css
page {
  background: #f4f7f2;
  color: #17352b;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

Create `miniprogram/sitemap.json`:

```json
{
  "desc": "Fitness local phase one",
  "rules": [{ "action": "allow", "page": "pages/planning-preview/index" }]
}
```

Create `miniprogram/pages/planning-preview/index.ts`:

```ts
import type { PlanningApiResponse, PlanningApiRequest } from '@fitness/contracts';
import { planningApiClient } from '../../services/planning-api';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type SupportedResult = Extract<SuccessData, { kind: 'supported' }>;
type UnsupportedResult = Extract<SuccessData, { kind: 'unsupported' }>;

interface TextValueEvent { readonly detail: { readonly value: string } }
interface SwitchValueEvent { readonly detail: { readonly value: boolean } }

const activityValues = ['light', 'moderate', 'heavy'] as const;
const goalValues = ['maintain', 'fat_loss', 'muscle_gain'] as const;

interface PageData {
  ageYears: string;
  heightCm: string;
  weightKg: string;
  durationMinutes: string;
  sexCode: '0' | '1';
  activityIndex: number;
  activityLabels: readonly string[];
  goalIndex: number;
  goalLabels: readonly string[];
  trainingIndex: number;
  trainingLabels: readonly string[];
  healthScopeConfirmed: boolean;
  loading: boolean;
  supportedResult: SupportedResult | null;
  supportedSourceText: string;
  unsupportedResult: UnsupportedResult | null;
  unsupportedReasonText: string;
  errorMessage: string;
}

interface PageActions {
  onAgeInput(event: TextValueEvent): void;
  onHeightInput(event: TextValueEvent): void;
  onWeightInput(event: TextValueEvent): void;
  onDurationInput(event: TextValueEvent): void;
  onSexChange(event: TextValueEvent): void;
  onActivityChange(event: TextValueEvent): void;
  onGoalChange(event: TextValueEvent): void;
  onTrainingChange(event: TextValueEvent): void;
  onHealthScopeChange(event: SwitchValueEvent): void;
  onSubmit(): Promise<void>;
}

function reasonText(reasons: readonly string[]): string {
  return reasons.map((reason) => {
    if (reason === 'age_out_of_range') return '年龄不在 18–45 岁范围内';
    if (reason === 'bmi_out_of_range') return 'BMI 不在 18.5–<24.0 范围内';
    if (reason === 'health_scope_not_confirmed') return '尚未完成健康适用范围确认';
    return '存在不支持自动个性化能量的条件';
  }).join('；');
}

function pickerIndex(value: string, length: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : 0;
}

Page<PageData, PageActions>({
  data: {
    ageYears: '30',
    heightCm: '175',
    weightKg: '70',
    durationMinutes: '60',
    sexCode: '0',
    activityIndex: 0,
    activityLabels: ['轻：久坐工作，少量通勤家务', '中：较多走动或体力家务', '重：持续体力工作'],
    goalIndex: 0,
    goalLabels: ['维持', '减脂', '增肌'],
    trainingIndex: 0,
    trainingLabels: ['无计划训练', '多动作抗阻训练（会话 02054）'],
    healthScopeConfirmed: false,
    loading: false,
    supportedResult: null,
    supportedSourceText: '',
    unsupportedResult: null,
    unsupportedReasonText: '',
    errorMessage: ''
  },
  onAgeInput(event) { this.setData({ ageYears: event.detail.value }); },
  onHeightInput(event) { this.setData({ heightCm: event.detail.value }); },
  onWeightInput(event) { this.setData({ weightKg: event.detail.value }); },
  onDurationInput(event) { this.setData({ durationMinutes: event.detail.value }); },
  onSexChange(event) { this.setData({ sexCode: event.detail.value === '1' ? '1' : '0' }); },
  onActivityChange(event) {
    this.setData({ activityIndex: pickerIndex(event.detail.value, activityValues.length) });
  },
  onGoalChange(event) {
    this.setData({ goalIndex: pickerIndex(event.detail.value, goalValues.length) });
  },
  onTrainingChange(event) {
    this.setData({ trainingIndex: pickerIndex(event.detail.value, 2) });
  },
  onHealthScopeChange(event) { this.setData({ healthScopeConfirmed: event.detail.value }); },
  async onSubmit() {
    this.setData({
      loading: true,
      supportedResult: null,
      supportedSourceText: '',
      unsupportedResult: null,
      unsupportedReasonText: '',
      errorMessage: ''
    });
    const activity = activityValues[this.data.activityIndex] ?? 'light';
    const goal = goalValues[this.data.goalIndex] ?? 'maintain';
    const training = this.data.trainingIndex === 1
      ? { sessionCode: '02054', durationMinutes: Number(this.data.durationMinutes) }
      : undefined;
    const request: PlanningApiRequest = {
      action: 'previewDailyEnergy',
      payload: {
        ageYears: Number(this.data.ageYears),
        sexCode: this.data.sexCode === '0' ? 0 : 1,
        heightCm: Number(this.data.heightCm),
        weightKg: Number(this.data.weightKg),
        healthScopeConfirmed: this.data.healthScopeConfirmed,
        nonTrainingActivity: activity,
        goal,
        ...(training === undefined ? {} : { training })
      }
    };
    try {
      const response = await planningApiClient.call(request);
      if (!response.success) {
        this.setData({ errorMessage: response.error.message });
      } else if (response.data.kind === 'supported') {
        this.setData({
          supportedResult: response.data,
          supportedSourceText: response.data.policy.sourceIds.join('、')
        });
      } else if (response.data.kind === 'unsupported') {
        this.setData({
          unsupportedResult: response.data,
          unsupportedReasonText: reasonText(response.data.reasons)
        });
      } else {
        this.setData({ errorMessage: '规划服务返回了非预期结果。' });
      }
    } catch (error: unknown) {
      this.setData({ errorMessage: error instanceof Error ? error.message : '本地规划服务暂时不可用。' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
```

Create `miniprogram/pages/planning-preview/index.json`:

```json
{
  "navigationBarTitleText": "每日能量规划预览",
  "usingComponents": {}
}
```

Create `miniprogram/pages/planning-preview/index.wxml`:

```xml
<view class="page">
  <view class="hero">
    <text class="eyebrow">FITNESS · 第一阶段</text>
    <text class="title">每日能量规划预览</text>
    <text class="subtitle">结果为初始估算，仅供一般健身与膳食规划参考。</text>
  </view>
  <view class="card">
    <input type="number" value="{{ageYears}}" bindinput="onAgeInput" placeholder="年龄（18–45 岁）" />
    <input type="digit" value="{{heightCm}}" bindinput="onHeightInput" placeholder="身高（厘米）" />
    <input type="digit" value="{{weightKg}}" bindinput="onWeightInput" placeholder="体重（千克）" />
    <radio-group bindchange="onSexChange">
      <label><radio value="0" checked="{{sexCode === '0'}}" />男</label>
      <label><radio value="1" checked="{{sexCode === '1'}}" />女</label>
    </radio-group>
    <picker range="{{activityLabels}}" value="{{activityIndex}}" bindchange="onActivityChange">
      <view>非训练日常活动：{{activityLabels[activityIndex]}}</view>
    </picker>
    <picker range="{{goalLabels}}" value="{{goalIndex}}" bindchange="onGoalChange">
      <view>目标：{{goalLabels[goalIndex]}}</view>
    </picker>
    <picker range="{{trainingLabels}}" value="{{trainingIndex}}" bindchange="onTrainingChange">
      <view>当日训练：{{trainingLabels[trainingIndex]}}</view>
    </picker>
    <input wx:if="{{trainingIndex === 1}}" type="digit" value="{{durationMinutes}}" bindinput="onDurationInput" placeholder="有效训练分钟数" />
    <label class="consent"><switch checked="{{healthScopeConfirmed}}" bindchange="onHealthScopeChange" />我已确认不属于疾病治疗、孕哺期、进食障碍或伤病康复等需专业管理人群</label>
    <button type="primary" loading="{{loading}}" disabled="{{loading}}" bindtap="onSubmit">生成预览</button>
  </view>
  <view wx:if="{{supportedResult}}" class="card result-card">
    <text class="section-title">今日规划起点</text>
    <view class="metric"><text>BMI</text><text>{{supportedResult.bmi}}</text></view>
    <view class="metric"><text>估算 BMR</text><text>{{supportedResult.estimatedBmrKcal}} kcal</text></view>
    <view class="metric"><text>非训练基线</text><text>{{supportedResult.nonTrainingBaselineKcal}} kcal</text></view>
    <view class="metric"><text>训练净消耗</text><text>{{supportedResult.trainingNetKcal}} kcal</text></view>
    <view class="metric"><text>估算维持消耗</text><text>{{supportedResult.estimatedMaintenanceKcal}} kcal</text></view>
    <view class="metric primary"><text>目标能量起点</text><text>{{supportedResult.targetEnergyKcal}} kcal</text></view>
    <text class="metadata">策略：{{supportedResult.policy.policyVersion}}</text>
    <text class="metadata">来源：{{supportedSourceText}}</text>
    <text class="disclaimer">{{supportedResult.disclaimer}}</text>
  </view>
  <view wx:if="{{unsupportedResult}}" class="card warning-card">
    <text class="section-title">暂不生成个性化能量目标</text>
    <text>BMI（仅用于范围判断）：{{unsupportedResult.bmi}}</text>
    <text class="warning-text">{{unsupportedReasonText}}</text>
    <text class="metadata">策略：{{unsupportedResult.policy.policyVersion}}</text>
  </view>
  <view wx:if="{{errorMessage}}" class="error">{{errorMessage}}</view>
  <text class="phase-note">本阶段仅提供每日能量起点预览，尚未生成宏量营养目标或食谱。</text>
</view>
```

Create `miniprogram/pages/planning-preview/index.wxss`:

```css
.page { padding: 32rpx; }
.hero { display: flex; flex-direction: column; gap: 12rpx; padding: 28rpx 8rpx; }
.eyebrow { color: #4f7668; font-size: 22rpx; letter-spacing: 4rpx; }
.title { font-size: 48rpx; font-weight: 700; }
.subtitle, .phase-note, .metadata, .disclaimer { color: #5e716a; font-size: 24rpx; line-height: 1.6; }
.card { margin-bottom: 24rpx; padding: 32rpx; border: 1rpx solid #dce7e1; border-radius: 28rpx; background: #ffffff; box-shadow: 0 12rpx 36rpx rgba(28, 62, 50, 0.08); }
input, picker, radio-group, .consent { display: block; margin-bottom: 24rpx; padding: 20rpx; border-radius: 16rpx; background: #f4f7f2; }
radio { margin-right: 8rpx; }
label { margin-right: 24rpx; }
.consent { font-size: 24rpx; line-height: 1.5; }
.section-title { display: block; margin-bottom: 20rpx; font-size: 32rpx; font-weight: 700; }
.metric { display: flex; justify-content: space-between; padding: 14rpx 0; border-bottom: 1rpx solid #edf1ef; }
.metric.primary { color: #116149; font-size: 30rpx; font-weight: 700; }
.metadata, .disclaimer, .warning-text { display: block; margin-top: 16rpx; }
.warning-card { border-color: #f2c98d; background: #fffaf1; }
.warning-text, .error { color: #9a4d20; }
.error { margin: 20rpx 0; padding: 24rpx; border-radius: 16rpx; background: #fff1ec; }
.phase-note { display: block; padding: 12rpx 8rpx 40rpx; }
```

- [x] **Step 5: Add the reproducible mini program build**

Create `scripts/build-miniprogram.mjs`:

```js
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'miniprogram');
const buildRoot = path.join(repositoryRoot, '.build');
const outputRoot = path.join(buildRoot, 'miniprogram');

if (path.dirname(outputRoot) !== buildRoot) {
  throw new Error(`Refusing to clean unexpected output directory: ${outputRoot}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: {
    app: 'miniprogram/app.ts',
    'pages/planning-preview/index': 'miniprogram/pages/planning-preview/index.ts'
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outdir: outputRoot,
  legalComments: 'none',
  sourcemap: false
});

const assets = [
  'app.json',
  'app.wxss',
  'sitemap.json',
  'pages/planning-preview/index.json',
  'pages/planning-preview/index.wxml',
  'pages/planning-preview/index.wxss'
];

for (const relativePath of assets) {
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(sourceRoot, relativePath), destination);
}
```

The exact copied assets are:

```text
miniprogram/app.json
miniprogram/app.wxss
miniprogram/sitemap.json
miniprogram/pages/planning-preview/index.json
miniprogram/pages/planning-preview/index.wxml
miniprogram/pages/planning-preview/index.wxss
```

Create `project.config.json`:

```json
{
  "description": "Fitness local development project",
  "miniprogramRoot": ".build/miniprogram/",
  "cloudfunctionRoot": "cloudfunctions/",
  "compileType": "miniprogram",
  "appid": "touristappid",
  "projectname": "fitness-local",
  "setting": {
    "urlCheck": false,
    "es6": true,
    "enhance": true,
    "postcss": true,
    "minified": false
  }
}
```

Create `project.private.config.example.json`:

```json
{
  "description": "Copy to project.private.config.json for developer-specific settings",
  "setting": {
    "compileHotReLoad": true
  }
}
```

- [x] **Step 6: Add a developer-tools launcher with no hard-coded user path**

Create `scripts/open-miniprogram.ps1`:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliPath = $env:WECHAT_DEVTOOLS_CLI

if ([string]::IsNullOrWhiteSpace($cliPath) -or -not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  $cliPath = $null
  $shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\微信开发者工具\微信开发者工具.lnk'
  if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    $shell = New-Object -ComObject WScript.Shell
    $targetPath = $shell.CreateShortcut($shortcutPath).TargetPath
    $shortcutCli = Join-Path (Split-Path -Parent $targetPath) 'cli.bat'
    if (Test-Path -LiteralPath $shortcutCli -PathType Leaf) {
      $cliPath = $shortcutCli
    }
  }
}

if ([string]::IsNullOrWhiteSpace($cliPath)) {
  $candidates = @(
    'C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat',
    'C:\Program Files\Tencent\微信开发者工具\cli.bat'
  )
  $cliPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($cliPath)) {
  throw '未找到微信开发者工具 CLI；请设置 WECHAT_DEVTOOLS_CLI 为 cli.bat 的绝对路径。'
}

& $cliPath open --project $repositoryRoot
if ($LASTEXITCODE -ne 0) {
  throw "微信开发者工具 CLI 打开项目失败，退出码：$LASTEXITCODE"
}
```

The script resolves `WECHAT_DEVTOOLS_CLI`, the current user's Start Menu shortcut, then the two standard install paths. It does not upload, preview, log in, or write an AppID.

- [x] **Step 7: Verify mini program tests, build, and local project loading**

Run:

```powershell
pnpm.cmd exec vitest run miniprogram/services/planning-api.test.ts
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd build:miniprogram
pnpm.cmd open:miniprogram
```

Expected: tests/typecheck/lint/build exit `0`; `.build/miniprogram` contains `app.js` and `pages/planning-preview/index.js`; the developer-tools CLI exits `0` after opening the repository project. If guest AppID or login prevents IDE compilation, capture that exact limitation and do not claim a successful developer-tools compile.

- [x] **Step 8: Commit the native mini program source and build scripts**

```powershell
git add -- .gitignore package.json pnpm-lock.yaml miniprogram scripts/build-miniprogram.mjs scripts/open-miniprogram.ps1 project.config.json project.private.config.example.json
git commit -m "feat: add local planning mini program"
```

---

### Task 8: Document startup, run full verification, and audit the deliverable

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-30-local-runnable-architecture.md` checkboxes only as each step is evidenced

**Interfaces:**
- Consumes: every prior task and the approved design acceptance criteria.
- Produces: accurate local-run documentation and fresh completion evidence for all Phase 1 requirements.

- [x] **Step 1: Update README status and local-run instructions**

Change the status line to:

```markdown
> 项目状态：第一阶段本地纵向切片可运行  
```

Add a `## 第一阶段本地运行` section containing these exact commands and expected endpoints:

```powershell
pnpm.cmd install
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dev:api
```

Document that `pnpm dev:api` listens on `http://127.0.0.1:3000`, `pnpm smoke:api` performs process-level verification, and `pnpm open:miniprogram` builds then opens the project in WeChat Developer Tools. State explicitly that Phase 1 does not persist data, generate macros/recipes, call CloudBase resources, or contact external providers.

- [x] **Step 2: Invoke verification-before-completion and run the full automated gate**

Run fresh, in this order:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd dry-run:api
pnpm.cmd smoke:api
```

Expected: every command exits `0`; record the test counts and smoke-test scenario count from current output.

- [ ] **Step 3: Verify the mini program in the installed developer tools**

Run:

```powershell
pnpm.cmd open:miniprogram
```

Expected: the installed CLI opens the project with exit `0`. In the IDE, confirm the planning form renders, start `pnpm dev:api`, submit the supported 70 kg/175 cm case, and observe target energy `2557 kcal`; submit the BMI `24.0` case and observe the unsupported message with no target energy. If interactive IDE state cannot be inspected automatically, report this as a manual verification item rather than claiming it passed.

- [x] **Step 4: Audit secrets, generated files, and architecture boundaries**

Run:

```powershell
rg -n "(BEGIN [A-Z ]*PRIVATE KEY|SECRET_ID|SECRET_KEY|API_KEY|sk-[A-Za-z0-9])" --glob "!pnpm-lock.yaml" --glob "!docs/**" .
rg -n "from ['\"](@cloudbase|langgraph|@langchain)|wx\." packages/domain packages/calculation
rg -n "14\.52|155\.88|565\.79|MET|1\.50|1\.75|2\.00|\-10%|\+5%" miniprogram
git status --short --untracked-files=all
git diff --check
git diff --stat
```

Expected:

- Secret scan has no matches.
- Domain/calculation forbidden-dependency scan has no matches.
- Mini program constant scan has no matches outside explanatory user copy.
- `node_modules`, `dist`, `.build`, logs, `.env`, and private config are absent from Git status.
- Diff check reports no whitespace errors.
- Only intended Phase 1 files and pre-existing user-owned untracked documentation remain.

- [x] **Step 5: Reconcile documentation with actual commands**

Compare `README.md`, `package.json`, `project.config.json`, `cloudbaserc.json`, and the approved design. Correct any command, path, port, runtime, limitation, or feature-boundary mismatch before proceeding. Do not broaden Phase 1 to persistence, macros, recipes, Agent, or providers.

- [x] **Step 6: Commit documentation and final plan state**

```powershell
git add -- README.md docs/superpowers/plans/2026-07-30-local-runnable-architecture.md
git commit -m "docs: add local development workflow"
```

- [ ] **Step 7: Run a post-commit verification snapshot**

Run:

```powershell
git status --short --untracked-files=all
git log --oneline --decorate -8
pnpm.cmd smoke:api
```

Expected: the only untracked files are pre-existing user-owned documents not intentionally committed; the planned commits are visible; the fresh smoke test still passes after the documentation commit.

## Plan Self-Review Mapping

- Workspace, strict TypeScript, exact package boundaries, and generated-artifact rules: Task 1.
- `calculation-policy-v2`, raw eligibility boundaries, source metadata, and rounding: Tasks 2–3.
- Reviewed Compendium session code `02054` and no client MET: Tasks 1, 3, and 7.
- Application orchestration and fail-closed unreviewed sessions: Task 4.
- Schema validation, action whitelist, stable error mapping, and no request-body logs: Task 5.
- Real local `tcb-ff` process with health/supported/unsupported HTTP evidence: Task 6.
- Native mini program, response validation, developer-tools project, and local endpoint: Task 7.
- Lint, typecheck, tests, build, dry run, smoke, IDE handoff, secret scan, boundary scan, docs, and diff audit: Task 8.
- No Phase 1 persistence, external provider, Agent, macro, recipe, or placeholder modules: Global Constraints and Tasks 7–8.
