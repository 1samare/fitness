import type {
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  FoodGroupId,
  NutrientValues,
  NutritionDataSnapshot,
  RecipeTemplateVersion
} from '@fitness/domain';

const FIXTURE_METADATA = {
  sourceId: 'FITNESS-TEST-FIXTURE-V2',
  provider: 'fitness-test-fixture',
  originalUnit: 'per_100_g_edible_portion',
  datasetVersion: 'fixture-2026-08-10',
  snapshotVersion: 1,
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture'
} as const;

export const TEST_INGREDIENT_VISION_RESPONSE = Object.freeze({
  requestId: 'fixture-vision-request-v1',
  candidates: Object.freeze([{
    providerCandidateId: 'fixture-vision-rice-cooked-v1',
    name: '测试米饭',
    confidence: 0.97,
    foodState: 'cooked' as const
  }])
});

export const TEST_FOOD_KEYS = [
  'rice', 'oats', 'sweet-potato', 'corn',
  'broccoli', 'spinach', 'carrot', 'tomato', 'mushroom', 'cabbage',
  'apple', 'banana', 'orange', 'blueberry',
  'chicken', 'beef', 'egg', 'fish',
  'tofu', 'soybean', 'peanut', 'walnut',
  'milk', 'yogurt',
  'canola-oil', 'sesame-oil',
  'seaweed', 'sesame'
] as const;

type TestFoodKey = (typeof TEST_FOOD_KEYS)[number];

interface FixtureFood {
  readonly canonicalNameZh: string;
  readonly foodGroupId: FoodGroupId;
  readonly foodState: 'raw' | 'cooked' | 'dry';
  readonly allergens: readonly string[];
  readonly nutrientsPer100g: NutrientValues;
}

function nutrients(
  energyKcal: number,
  proteinG: number,
  fatG: number,
  carbohydrateG: number,
  fiberG: number,
  saturatedFatG: number,
  addedSugarG = 0
): NutrientValues {
  return { energyKcal, proteinG, fatG, carbohydrateG, fiberG, saturatedFatG, addedSugarG };
}

const TEST_FOOD_DATA: Readonly<Record<TestFoodKey, FixtureFood>> = {
  rice: { canonicalNameZh: '测试米饭', foodGroupId: 'grains_tubers', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(116, 2.6, 0.3, 25.9, 0.3, 0.1) },
  oats: { canonicalNameZh: '测试燕麦', foodGroupId: 'grains_tubers', foodState: 'dry', allergens: ['含麸质谷物'], nutrientsPer100g: nutrients(367, 13.1, 6.7, 62.6, 10.6, 1.2) },
  'sweet-potato': { canonicalNameZh: '测试红薯', foodGroupId: 'grains_tubers', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(76, 1.1, 0.2, 17.1, 2.5, 0) },
  corn: { canonicalNameZh: '测试玉米', foodGroupId: 'grains_tubers', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(112, 3.8, 1.2, 22.8, 2.9, 0.2) },
  broccoli: { canonicalNameZh: '测试西兰花', foodGroupId: 'vegetables', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(33, 2.8, 0.4, 5.2, 3.1, 0.1) },
  spinach: { canonicalNameZh: '测试菠菜', foodGroupId: 'vegetables', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(23, 2.9, 0.4, 3.6, 2.2, 0.1) },
  carrot: { canonicalNameZh: '测试胡萝卜', foodGroupId: 'vegetables', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(35, 0.8, 0.2, 8.2, 2.8, 0) },
  tomato: { canonicalNameZh: '测试番茄', foodGroupId: 'vegetables', foodState: 'raw', allergens: [], nutrientsPer100g: nutrients(18, 0.9, 0.2, 3.9, 1.2, 0) },
  mushroom: { canonicalNameZh: '测试蘑菇', foodGroupId: 'vegetables', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(28, 2.7, 0.5, 4.4, 1.5, 0.1) },
  cabbage: { canonicalNameZh: '测试卷心菜', foodGroupId: 'vegetables', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(24, 1.3, 0.1, 5.5, 2.2, 0) },
  apple: { canonicalNameZh: '测试苹果', foodGroupId: 'fruit', foodState: 'raw', allergens: [], nutrientsPer100g: nutrients(52, 0.3, 0.2, 13.8, 2.4, 0) },
  banana: { canonicalNameZh: '测试香蕉', foodGroupId: 'fruit', foodState: 'raw', allergens: [], nutrientsPer100g: nutrients(93, 1.1, 0.3, 22, 2.6, 0.1) },
  orange: { canonicalNameZh: '测试橙子', foodGroupId: 'fruit', foodState: 'raw', allergens: [], nutrientsPer100g: nutrients(48, 0.9, 0.2, 11.8, 2.4, 0) },
  blueberry: { canonicalNameZh: '测试蓝莓', foodGroupId: 'fruit', foodState: 'raw', allergens: [], nutrientsPer100g: nutrients(57, 0.7, 0.3, 14.5, 2.4, 0) },
  chicken: { canonicalNameZh: '测试鸡胸肉', foodGroupId: 'animal_protein', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(165, 31, 3.6, 0, 0, 1) },
  beef: { canonicalNameZh: '测试牛肉', foodGroupId: 'animal_protein', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(203, 26, 10, 0, 0, 4) },
  egg: { canonicalNameZh: '测试鸡蛋', foodGroupId: 'animal_protein', foodState: 'cooked', allergens: ['蛋类'], nutrientsPer100g: nutrients(143, 13, 10, 1.1, 0, 3.1) },
  fish: { canonicalNameZh: '测试鱼肉', foodGroupId: 'animal_protein', foodState: 'cooked', allergens: ['鱼类'], nutrientsPer100g: nutrients(128, 26, 2.7, 0, 0, 0.6) },
  tofu: { canonicalNameZh: '测试豆腐', foodGroupId: 'soy_nuts', foodState: 'cooked', allergens: ['大豆'], nutrientsPer100g: nutrients(100, 10, 5, 4, 2, 1) },
  soybean: { canonicalNameZh: '测试黄豆', foodGroupId: 'soy_nuts', foodState: 'cooked', allergens: ['大豆'], nutrientsPer100g: nutrients(172, 16.6, 8.6, 9.9, 6, 1.2) },
  peanut: { canonicalNameZh: '测试花生', foodGroupId: 'soy_nuts', foodState: 'dry', allergens: ['花生'], nutrientsPer100g: nutrients(567, 25.8, 49.2, 16.1, 8.5, 6.8) },
  walnut: { canonicalNameZh: '测试核桃', foodGroupId: 'soy_nuts', foodState: 'dry', allergens: ['坚果'], nutrientsPer100g: nutrients(654, 15.2, 65.2, 13.7, 6.7, 6.1) },
  milk: { canonicalNameZh: '测试牛奶', foodGroupId: 'dairy', foodState: 'raw', allergens: ['乳类'], nutrientsPer100g: nutrients(61, 3.2, 3.3, 4.8, 0, 2.1) },
  yogurt: { canonicalNameZh: '测试酸奶', foodGroupId: 'dairy', foodState: 'raw', allergens: ['乳类'], nutrientsPer100g: nutrients(72, 3.1, 3.1, 9.5, 0, 2) },
  'canola-oil': { canonicalNameZh: '测试菜籽油', foodGroupId: 'fats', foodState: 'raw', allergens: [], nutrientsPer100g: nutrients(884, 0, 100, 0, 0, 7) },
  'sesame-oil': { canonicalNameZh: '测试芝麻油', foodGroupId: 'fats', foodState: 'raw', allergens: ['芝麻'], nutrientsPer100g: nutrients(884, 0, 100, 0, 0, 14) },
  seaweed: { canonicalNameZh: '测试海带', foodGroupId: 'other', foodState: 'cooked', allergens: [], nutrientsPer100g: nutrients(17, 1.2, 0.2, 3.1, 1.6, 0) },
  sesame: { canonicalNameZh: '测试芝麻', foodGroupId: 'other', foodState: 'dry', allergens: ['芝麻'], nutrientsPer100g: nutrients(573, 17.7, 49.7, 23.5, 11.8, 7) }
};

export const TEST_NUTRITION_SNAPSHOTS = Object.freeze(TEST_FOOD_KEYS.map((key): NutritionDataSnapshot => {
  const food = TEST_FOOD_DATA[key];
  return {
    id: `snapshot-fixture-${key}-v1`,
    foodId: `fixture-${key}`,
    canonicalNameZh: food.canonicalNameZh,
    foodGroupId: food.foodGroupId,
    sourceRecordId: `fixture-${key}-001`,
    foodState: food.foodState,
    allergens: food.allergens,
    nutrientsPer100g: food.nutrientsPer100g,
    ...FIXTURE_METADATA
  };
}) satisfies readonly NutritionDataSnapshot[]);

const TEST_MENU_FOOD_KEY_SETS = [
  ['rice', 'oats', 'sweet-potato', 'corn', 'broccoli', 'spinach', 'apple', 'banana', 'chicken', 'beef', 'tofu', 'milk'],
  ['rice', 'corn', 'carrot', 'tomato', 'orange', 'blueberry', 'egg', 'fish', 'soybean', 'peanut', 'yogurt', 'canola-oil'],
  ['oats', 'sweet-potato', 'mushroom', 'cabbage', 'apple', 'orange', 'chicken', 'egg', 'walnut', 'milk', 'sesame-oil', 'seaweed'],
  ['rice', 'corn', 'broccoli', 'carrot', 'banana', 'blueberry', 'beef', 'fish', 'tofu', 'soybean', 'sesame', 'canola-oil'],
  ['oats', 'sweet-potato', 'spinach', 'tomato', 'apple', 'banana', 'chicken', 'beef', 'peanut', 'walnut', 'yogurt', 'seaweed'],
  ['rice', 'corn', 'mushroom', 'cabbage', 'orange', 'blueberry', 'egg', 'fish', 'tofu', 'soybean', 'milk', 'sesame'],
  ['oats', 'sweet-potato', 'broccoli', 'spinach', 'apple', 'orange', 'chicken', 'egg', 'peanut', 'walnut', 'canola-oil', 'sesame-oil']
] as const satisfies readonly (readonly TestFoodKey[])[];

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

function recipeVersionId(dayIndex: number, mealIndex: number): string {
  return `recipe-version-fixture-day-${String(dayIndex + 1)}-${MEAL_SLOTS[mealIndex] ?? 'unknown'}-v1`;
}

export const TEST_RECIPE_TEMPLATES = Object.freeze(TEST_MENU_FOOD_KEY_SETS.flatMap((foodKeys, dayIndex) => (
  MEAL_SLOTS.map((slot, mealIndex): RecipeTemplateVersion => ({
    id: recipeVersionId(dayIndex, mealIndex),
    templateId: `recipe-fixture-day-${String(dayIndex + 1)}-${slot}`,
    version: 1,
    dishNameZh: `测试第${String(dayIndex + 1)}日${slot}`,
    sourceId: FIXTURE_METADATA.sourceId,
    datasetVersion: FIXTURE_METADATA.datasetVersion,
    reviewedAt: FIXTURE_METADATA.reviewedAt,
    qualityStatus: FIXTURE_METADATA.qualityStatus,
    ingredients: foodKeys.slice(mealIndex * 3, mealIndex * 3 + 3).map((foodKey) => ({
      foodId: `fixture-${foodKey}`,
      nutritionSnapshotId: `snapshot-fixture-${foodKey}-v1`,
      grams: 100
    }))
  }))
)) satisfies readonly RecipeTemplateVersion[]);

export const TEST_ALLERGEN_CONFLICTING_RECIPE_VERSION_ID = recipeVersionId(1, 3);

export const TEST_DAILY_MENU_TEMPLATES = Object.freeze(TEST_MENU_FOOD_KEY_SETS.map((_, dayIndex): DailyMenuTemplateVersion => ({
  id: `daily-menu-version-fixture-day-${String(dayIndex + 1)}-v1`,
  datasetVersion: FIXTURE_METADATA.datasetVersion,
  sourceId: FIXTURE_METADATA.sourceId,
  reviewedAt: FIXTURE_METADATA.reviewedAt,
  qualityStatus: FIXTURE_METADATA.qualityStatus,
  meals: MEAL_SLOTS.map((slot, mealIndex) => ({
    slot,
    recipeTemplateVersionId: recipeVersionId(dayIndex, mealIndex)
  }))
})) satisfies readonly DailyMenuTemplateVersion[]);

export const TEST_DAILY_MENU_CATALOG: DailyMenuCatalogVersion = Object.freeze({
  id: 'daily-menu-catalog-fixture-week-v1',
  datasetVersion: FIXTURE_METADATA.datasetVersion,
  sourceId: FIXTURE_METADATA.sourceId,
  reviewedAt: FIXTURE_METADATA.reviewedAt,
  qualityStatus: FIXTURE_METADATA.qualityStatus,
  dailyMenuTemplateVersionIds: TEST_DAILY_MENU_TEMPLATES.map((menu) => menu.id)
});

const BALANCED_MEAL_FIXTURE_METADATA = {
  sourceId: 'FITNESS-TEST-FIXTURE-BALANCED-MEAL-V1',
  provider: 'fitness-test-fixture-balanced-meal',
  originalUnit: 'per_100_g_edible_portion',
  datasetVersion: 'fixture-balanced-meal-planning-2026-08-10',
  snapshotVersion: 1,
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture'
} as const;

function balancedMealSnapshotId(foodKey: TestFoodKey): string {
  return `snapshot-fixture-balanced-meal-${foodKey}-v1`;
}

function balancedMealRecipeVersionId(dayIndex: number, mealIndex: number): string {
  return `recipe-version-fixture-balanced-meal-day-${String(dayIndex + 1)}-${MEAL_SLOTS[mealIndex] ?? 'unknown'}-v1`;
}

/**
 * Deliberately synthetic, nutritionally balanced fixture graph for exercising
 * the deterministic whole-week solver in local/test runtime mode. Every node
 * has an identity independent from the raw fixture graph so persisted source
 * references remain immutable and reproducible.
 */
export const TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS = Object.freeze(
  TEST_FOOD_KEYS.map((foodKey): NutritionDataSnapshot => {
    const food = TEST_FOOD_DATA[foodKey];
    return {
      id: balancedMealSnapshotId(foodKey),
      foodId: `fixture-${foodKey}`,
      canonicalNameZh: food.canonicalNameZh,
      foodGroupId: food.foodGroupId,
      sourceRecordId: `fixture-balanced-meal-${foodKey}-001`,
      foodState: food.foodState,
      allergens: food.allergens,
      nutrientsPer100g: nutrients(160, 6.7, 4.5, 24, 2.2, 0.4),
      ...BALANCED_MEAL_FIXTURE_METADATA
    };
  }) satisfies readonly NutritionDataSnapshot[]
);

export const TEST_MEAL_PLANNING_RECIPE_TEMPLATES = Object.freeze(
  TEST_MENU_FOOD_KEY_SETS.flatMap((foodKeys, dayIndex) => (
    MEAL_SLOTS.map((slot, mealIndex): RecipeTemplateVersion => ({
      id: balancedMealRecipeVersionId(dayIndex, mealIndex),
      templateId: `recipe-fixture-balanced-meal-day-${String(dayIndex + 1)}-${slot}`,
      version: 1,
      dishNameZh: `测试均衡第${String(dayIndex + 1)}日${slot}`,
      sourceId: BALANCED_MEAL_FIXTURE_METADATA.sourceId,
      datasetVersion: BALANCED_MEAL_FIXTURE_METADATA.datasetVersion,
      reviewedAt: BALANCED_MEAL_FIXTURE_METADATA.reviewedAt,
      qualityStatus: BALANCED_MEAL_FIXTURE_METADATA.qualityStatus,
      ingredients: foodKeys.slice(mealIndex * 3, mealIndex * 3 + 3).map((foodKey) => ({
        foodId: `fixture-${foodKey}`,
        nutritionSnapshotId: balancedMealSnapshotId(foodKey),
        grams: 100
      }))
    }))
  )) satisfies readonly RecipeTemplateVersion[]
);

export const TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES = Object.freeze(
  TEST_MENU_FOOD_KEY_SETS.map((_, dayIndex): DailyMenuTemplateVersion => ({
    id: `daily-menu-version-fixture-balanced-meal-day-${String(dayIndex + 1)}-v1`,
    datasetVersion: BALANCED_MEAL_FIXTURE_METADATA.datasetVersion,
    sourceId: BALANCED_MEAL_FIXTURE_METADATA.sourceId,
    reviewedAt: BALANCED_MEAL_FIXTURE_METADATA.reviewedAt,
    qualityStatus: BALANCED_MEAL_FIXTURE_METADATA.qualityStatus,
    meals: MEAL_SLOTS.map((slot, mealIndex) => ({
      slot,
      recipeTemplateVersionId: balancedMealRecipeVersionId(dayIndex, mealIndex)
    }))
  })) satisfies readonly DailyMenuTemplateVersion[]
);

export const TEST_MEAL_PLANNING_DAILY_MENU_CATALOG: DailyMenuCatalogVersion = Object.freeze({
  id: 'daily-menu-catalog-fixture-balanced-meal-week-v1',
  datasetVersion: BALANCED_MEAL_FIXTURE_METADATA.datasetVersion,
  sourceId: BALANCED_MEAL_FIXTURE_METADATA.sourceId,
  reviewedAt: BALANCED_MEAL_FIXTURE_METADATA.reviewedAt,
  qualityStatus: BALANCED_MEAL_FIXTURE_METADATA.qualityStatus,
  dailyMenuTemplateVersionIds: TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES.map((menu) => menu.id)
});
