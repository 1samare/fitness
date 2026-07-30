# Calculation Policy v2 Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unqualified `energy-policy-v1` defaults with a source-bound, conservative `calculation-policy-v2` across the project documentation.

**Architecture:** The policy separates eligibility, basal energy, non-training activity, planned exercise, goal adjustment, nutrient constraints, and evidence provenance. Numerical recommendations remain deterministic and versioned; unsupported users or infeasible nutrition constraints receive an explicit refusal instead of invented values.

**Tech Stack:** Markdown documentation, deterministic TypeScript calculation engine planned for WeChat CloudBase, Chinese DRIs, peer-reviewed exercise-nutrition evidence.

## Global Constraints

- Serve healthy adults only; the first automated personalized energy policy is limited to ages 18–45 and BMI `18.5–<24.0`.
- Never claim medical-grade or exact calorie accuracy.
- The LLM never supplies calories, nutrient values, ingredient weights, MET values, or missing body data.
- Every numerical rule records its source, applicable population, effective version, and review date.
- If evidence, required inputs, or feasible nutrition data are missing, return an explicit unsupported result.
- Training-plan changes must deterministically update affected future nutrition targets and unlocked meal plans.

---

### Task 1: Replace the README calculation policy

**Files:**
- Modify: `README.md:208`

**Interfaces:**
- Consumes: approved scientific review and cited primary sources.
- Produces: the product-facing definition of `calculation-policy-v2` and its safety boundary.

- [x] **Step 1: Replace the BMR policy**

Document the Chinese normal-weight adult formula `14.52 × weightKg - 155.88 × sexCode + 565.79`, its sex coding, its 18–45 and BMI applicability limits, and the required “initial estimate” label.

- [x] **Step 2: Define non-training PAL and training energy**

Use PAL `1.50 / 1.75 / 2.00` only for work, commuting, and household activity that excludes logged workouts. Retain the net MET formula, require a reviewed session-level Compendium mapping, and prohibit per-exercise invented MET values.

- [x] **Step 3: Replace goal and nutrient defaults**

Set maintenance to `0%`, fat loss to an initial `-10%`, muscle gain to an initial `+5%`, and remove automatic widening to `±20%`. Define protein rules by training state, fat and carbohydrate ranges, fiber, saturated fat, and added sugar constraints.

- [x] **Step 4: Add evidence and refusal rules**

Add a source registry table, applicability requirements, BMI/goal stop conditions, and the requirement to return an infeasible or unsupported result when constraints cannot be satisfied.

### Task 2: Convert AGENTS.md requirements into enforceable rules

**Files:**
- Modify: `AGENTS.md:118`
- Modify: `AGENTS.md:129`

**Interfaces:**
- Consumes: the README policy contract.
- Produces: mandatory implementation and review rules for future Codex changes.

- [x] **Step 1: Replace obsolete calculation constants**

Remove Mifflin–St Jeor, `+10%` muscle gain, `±20%` automatic adjustment, universal `1.6 g/kg`, and unconstrained carbohydrate remainder.

- [x] **Step 2: Add fail-closed requirements**

Require eligibility checks, source identifiers, reviewed MET mappings, nutrient feasibility validation, and explicit refusal paths.

- [x] **Step 3: Add calculation change tests**

Require boundary, unsupported-population, no-double-counting, training-plan-delta, and infeasible-macro tests whenever the policy implementation changes.

### Task 3: Align the approved design specification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-fitness-planning-design.md:101`
- Modify: `docs/superpowers/specs/2026-07-30-fitness-planning-design.md:141`

**Interfaces:**
- Consumes: the README policy contract and AGENTS implementation constraints.
- Produces: an approved design that describes the same population, equations, safeguards, and plan-change behavior.

- [x] **Step 1: Rewrite the calculation design**

Describe the v2 formula, PAL separation, net exercise estimate, goal defaults, macro constraints, source metadata, and fail-closed behavior.

- [x] **Step 2: Clarify product scope**

Separate the healthy-adult product scope from the narrower population eligible for automated personalized energy targets; unsupported users may use non-personalized balanced recipes but not automated deficit or surplus targets.

- [x] **Step 3: Expand calculation acceptance tests**

Include policy scope boundaries, source integrity, training-plan change deltas, nutrient constraints, and absence of unsupported numerical output.

### Task 4: Verify cross-document consistency

**Files:**
- Verify: `README.md`
- Verify: `AGENTS.md`
- Verify: `docs/superpowers/specs/2026-07-30-fitness-planning-design.md`

**Interfaces:**
- Consumes: the three revised documents.
- Produces: fresh evidence that obsolete defaults are absent and every v2 requirement is present.

- [x] **Step 1: Scan for obsolete policy text**

Run:

```powershell
rg -n "Mifflin|energy-policy-v1|\+10%|\-20%|碳水承接剩余|碳水补足剩余" README.md AGENTS.md docs/superpowers/specs/2026-07-30-fitness-planning-design.md
```

Expected: no matches in active policy text.

- [x] **Step 2: Scan for required v2 controls**

Run:

```powershell
rg -n "calculation-policy-v2|14\.52|18\.5|1\.50|\+5%|120 g|25.*30|证据不足|不生成" README.md AGENTS.md docs/superpowers/specs/2026-07-30-fitness-planning-design.md
```

Expected: all three documents contain the policy version, eligibility boundary, scientific constants, and fail-closed rules appropriate to their role.

- [x] **Step 3: Validate Markdown structure**

Run a PowerShell check that every document is non-empty, contains balanced fenced code blocks, and contains no `TODO`, `TBD`, `FIXME`, or placeholder text.

Expected: exit code `0` with each file reported as valid.
