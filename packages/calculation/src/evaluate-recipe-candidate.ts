import type {
  FoodGroupId,
  NutrientValues,
  NutritionDataSnapshot,
  RecipeCandidateConflict,
  RecipeCandidateInput,
  RecipeCandidateResult
} from '@fitness/domain';
import { canonicalizeAllergenTerm } from '@fitness/domain';
import { roundHalfUp } from './rounding';

const ZERO_TOTALS: NutrientValues = {
  energyKcal: 0,
  proteinG: 0,
  fatG: 0,
  carbohydrateG: 0,
  fiberG: 0,
  saturatedFatG: 0,
  addedSugarG: 0
};

function addScaled(
  totals: NutrientValues,
  nutrients: NutrientValues,
  scale: number
): NutrientValues {
  return {
    energyKcal: totals.energyKcal + nutrients.energyKcal * scale,
    proteinG: totals.proteinG + nutrients.proteinG * scale,
    fatG: totals.fatG + nutrients.fatG * scale,
    carbohydrateG: totals.carbohydrateG + nutrients.carbohydrateG * scale,
    fiberG: totals.fiberG + nutrients.fiberG * scale,
    saturatedFatG: totals.saturatedFatG + nutrients.saturatedFatG * scale,
    addedSugarG: totals.addedSugarG + nutrients.addedSugarG * scale
  };
}

function scaleNutrients(nutrients: NutrientValues, grams: number): NutrientValues {
  const factor = grams / 100;
  return {
    energyKcal: roundHalfUp(nutrients.energyKcal * factor, 1),
    proteinG: roundHalfUp(nutrients.proteinG * factor, 1),
    fatG: roundHalfUp(nutrients.fatG * factor, 1),
    carbohydrateG: roundHalfUp(nutrients.carbohydrateG * factor, 1),
    fiberG: roundHalfUp(nutrients.fiberG * factor, 1),
    saturatedFatG: roundHalfUp(nutrients.saturatedFatG * factor, 1),
    addedSugarG: roundHalfUp(nutrients.addedSugarG * factor, 1)
  };
}

function roundTotals(totals: NutrientValues): NutrientValues {
  return {
    energyKcal: roundHalfUp(totals.energyKcal, 1),
    proteinG: roundHalfUp(totals.proteinG, 1),
    fatG: roundHalfUp(totals.fatG, 1),
    carbohydrateG: roundHalfUp(totals.carbohydrateG, 1),
    fiberG: roundHalfUp(totals.fiberG, 1),
    saturatedFatG: roundHalfUp(totals.saturatedFatG, 1),
    addedSugarG: roundHalfUp(totals.addedSugarG, 1)
  };
}

function pushSnapshotConflicts(input: {
  readonly snapshot: NutritionDataSnapshot;
  readonly foodId: string;
  readonly snapshotId: string;
  readonly allowTestFixtures: boolean;
  readonly declaredAllergens: ReadonlySet<string>;
  readonly conflicts: RecipeCandidateConflict[];
}): void {
  if (input.snapshot.foodId !== input.foodId) {
    input.conflicts.push({
      code: 'nutrition_snapshot_identity_mismatch',
      foodId: input.foodId,
      snapshotId: input.snapshotId
    });
  }
  if (input.snapshot.qualityStatus !== 'reviewed' && !input.allowTestFixtures) {
    input.conflicts.push({
      code: 'nutrition_snapshot_not_reviewed',
      foodId: input.foodId,
      snapshotId: input.snapshotId
    });
  }
  const matchingAllergen = input.snapshot.allergens.find((allergen) => (
    input.declaredAllergens.has(canonicalizeAllergenTerm(allergen))
  ));
  if (matchingAllergen !== undefined) {
    input.conflicts.push({
      code: 'allergen_detected',
      foodId: input.foodId,
      allergen: matchingAllergen
    });
  }
}

export function evaluateRecipeCandidate(
  input: RecipeCandidateInput
): RecipeCandidateResult {
  const conflicts: RecipeCandidateConflict[] = [];
  if (input.template.qualityStatus !== 'reviewed' && !input.allowTestFixtures) {
    conflicts.push({
      code: 'recipe_template_not_reviewed',
      templateVersionId: input.template.id
    });
  }

  const snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const inventory = new Map(input.inventory.map((item) => [item.foodId, item.availableGrams]));
  const avoidedFoodIds = new Set(input.avoidFoodIds);
  const declaredAllergens = new Set(input.allergens.map(canonicalizeAllergenTerm));
  const foodGroupIds: FoodGroupId[] = [];
  const sourceSnapshotIds: string[] = [];
  const requiredGramsByFood = new Map<string, number>();
  let totals = ZERO_TOTALS;

  for (const ingredient of input.template.ingredients) {
    const snapshot = snapshots.get(ingredient.nutritionSnapshotId);
    if (snapshot === undefined) {
      conflicts.push({
        code: 'nutrition_snapshot_missing',
        foodId: ingredient.foodId,
        snapshotId: ingredient.nutritionSnapshotId
      });
      continue;
    }

    pushSnapshotConflicts({
      snapshot,
      foodId: ingredient.foodId,
      snapshotId: ingredient.nutritionSnapshotId,
      allowTestFixtures: input.allowTestFixtures,
      declaredAllergens,
      conflicts
    });
    if (avoidedFoodIds.has(ingredient.foodId)) {
      conflicts.push({ code: 'avoided_food', foodId: ingredient.foodId });
    }
    const actualGrams = roundHalfUp(ingredient.grams, 1);
    requiredGramsByFood.set(
      ingredient.foodId,
      roundHalfUp((requiredGramsByFood.get(ingredient.foodId) ?? 0) + actualGrams, 1)
    );
    totals = addScaled(totals, scaleNutrients(snapshot.nutrientsPer100g, actualGrams), 1);
    if (!sourceSnapshotIds.includes(snapshot.id)) sourceSnapshotIds.push(snapshot.id);
    if (!foodGroupIds.includes(snapshot.foodGroupId)) {
      foodGroupIds.push(snapshot.foodGroupId);
    }
  }

  for (const [foodId, requiredGrams] of requiredGramsByFood) {
    const availableGrams = inventory.get(foodId) ?? 0;
    if (availableGrams < requiredGrams) {
      conflicts.push({
        code: 'inventory_insufficient',
        foodId,
        requiredGrams,
        availableGrams
      });
    }
  }

  if (foodGroupIds.length < input.minimumDistinctFoodGroups) {
    conflicts.push({
      code: 'food_diversity_insufficient',
      requiredCount: input.minimumDistinctFoodGroups,
      actualCount: foodGroupIds.length
    });
  }
  if (conflicts.length > 0) {
    return { kind: 'infeasible', code: 'nutrition_constraints_infeasible', conflicts };
  }
  return {
    kind: 'accepted',
    totals: roundTotals(totals),
    sourceSnapshotIds,
    foodGroupIds
  };
}
