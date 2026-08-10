export interface NutrientValues {
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbohydrateG: number;
  readonly fiberG: number;
  readonly saturatedFatG: number;
  readonly addedSugarG: number;
}

export type FoodGroupId =
  | 'grains_tubers'
  | 'vegetables'
  | 'fruit'
  | 'animal_protein'
  | 'soy_nuts'
  | 'dairy'
  | 'fats'
  | 'other';

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

export interface RecipeIngredient {
  readonly foodId: string;
  readonly nutritionSnapshotId: string;
  readonly grams: number;
}

export interface RecipeTemplateVersion {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly dishNameZh: string;
  readonly sourceId: string;
  readonly datasetVersion: string;
  readonly reviewedAt: string;
  readonly qualityStatus: 'reviewed' | 'test_fixture';
  readonly ingredients: readonly RecipeIngredient[];
}

export interface NutritionProvider {
  getSnapshot(snapshotId: string): Promise<NutritionDataSnapshot>;
  resolveCanonicalName(name: string): Promise<FoodResolution | null>;
}

export interface FoodResolution {
  readonly foodId: string;
  readonly canonicalNameZh: string;
  readonly nutritionSnapshotId: string;
}

export interface RecipeTemplateProvider {
  getByVersionId(versionId: string): Promise<RecipeTemplateVersion>;
}

export interface RecipeCandidateInput {
  readonly template: RecipeTemplateVersion;
  readonly snapshots: readonly NutritionDataSnapshot[];
  readonly inventory: readonly {
    readonly foodId: string;
    readonly availableGrams: number;
  }[];
  readonly allergens: readonly string[];
  readonly avoidFoodIds: readonly string[];
  readonly minimumDistinctFoodGroups: number;
  readonly allowTestFixtures: boolean;
}

export type RecipeCandidateConflict =
  | { readonly code: 'recipe_template_not_reviewed'; readonly templateVersionId: string }
  | {
      readonly code: 'nutrition_snapshot_missing';
      readonly foodId: string;
      readonly snapshotId: string;
    }
  | {
      readonly code: 'nutrition_snapshot_identity_mismatch';
      readonly foodId: string;
      readonly snapshotId: string;
    }
  | {
      readonly code: 'nutrition_snapshot_not_reviewed';
      readonly foodId: string;
      readonly snapshotId: string;
    }
  | { readonly code: 'allergen_detected'; readonly foodId: string; readonly allergen: string }
  | { readonly code: 'avoided_food'; readonly foodId: string }
  | {
      readonly code: 'inventory_insufficient';
      readonly foodId: string;
      readonly requiredGrams: number;
      readonly availableGrams: number;
    }
  | {
      readonly code: 'food_diversity_insufficient';
      readonly requiredCount: number;
      readonly actualCount: number;
    };

export type RecipeCandidateResult =
  | {
      readonly kind: 'accepted';
      readonly totals: NutrientValues;
      readonly sourceSnapshotIds: readonly string[];
      readonly foodGroupIds: readonly FoodGroupId[];
    }
  | {
      readonly kind: 'infeasible';
      readonly code: 'nutrition_constraints_infeasible';
      readonly conflicts: readonly RecipeCandidateConflict[];
    };

export function canonicalizeAllergenTerm(value: string): string {
  return value.trim().replaceAll(/\s+/g, '').toLocaleLowerCase('zh-CN');
}
