import { z } from 'zod';

export const traceableIdSchema = z.string().trim().min(1).max(256);
const nonNegativeNutrientSchema = z.number().nonnegative();

export const nutrientValuesSchema = z.object({
  energyKcal: nonNegativeNutrientSchema,
  proteinG: nonNegativeNutrientSchema,
  fatG: nonNegativeNutrientSchema,
  carbohydrateG: nonNegativeNutrientSchema,
  fiberG: nonNegativeNutrientSchema,
  saturatedFatG: nonNegativeNutrientSchema,
  addedSugarG: nonNegativeNutrientSchema
}).strict();

export const foodGroupIdSchema = z.enum([
  'grains_tubers',
  'vegetables',
  'fruit',
  'animal_protein',
  'soy_nuts',
  'dairy',
  'fats',
  'other'
]);

export const nutritionDataSnapshotSchema = z.object({
  id: traceableIdSchema,
  foodId: traceableIdSchema,
  canonicalNameZh: z.string().trim().min(1).max(120),
  foodGroupId: foodGroupIdSchema,
  sourceId: traceableIdSchema,
  sourceRecordId: traceableIdSchema,
  provider: z.string().trim().min(1).max(120),
  originalUnit: z.literal('per_100_g_edible_portion'),
  foodState: z.enum(['raw', 'cooked', 'dry']),
  datasetVersion: traceableIdSchema,
  snapshotVersion: z.number().int().positive(),
  reviewedAt: z.iso.datetime(),
  qualityStatus: z.enum(['reviewed', 'test_fixture']),
  allergens: z.array(z.string().trim().min(1).max(80)).max(50),
  nutrientsPer100g: nutrientValuesSchema
}).strict();

const recipeIngredientSchema = z.object({
  foodId: traceableIdSchema,
  nutritionSnapshotId: traceableIdSchema,
  grams: z.number().positive().max(10_000)
}).strict();

export const recipeTemplateVersionSchema = z.object({
  id: traceableIdSchema,
  templateId: traceableIdSchema,
  version: z.number().int().positive(),
  dishNameZh: z.string().trim().min(1).max(120),
  sourceId: traceableIdSchema,
  datasetVersion: traceableIdSchema,
  reviewedAt: z.iso.datetime(),
  qualityStatus: z.enum(['reviewed', 'test_fixture']),
  ingredients: z.array(recipeIngredientSchema).min(1).max(100)
}).strict().superRefine((value, context) => {
  const foodIds = new Set<string>();
  const snapshotIds = new Set<string>();
  value.ingredients.forEach((ingredient, index) => {
    if (foodIds.has(ingredient.foodId)) {
      context.addIssue({
        code: 'custom',
        path: ['ingredients', index, 'foodId'],
        message: 'recipe foodId must be unique'
      });
    }
    if (snapshotIds.has(ingredient.nutritionSnapshotId)) {
      context.addIssue({
        code: 'custom',
        path: ['ingredients', index, 'nutritionSnapshotId'],
        message: 'recipe nutritionSnapshotId must be unique'
      });
    }
    foodIds.add(ingredient.foodId);
    snapshotIds.add(ingredient.nutritionSnapshotId);
  });
});

const mealSlotSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);

export const mealAssignmentSchema = z.object({
  slot: mealSlotSchema,
  recipeTemplateVersionId: traceableIdSchema,
  servingMultiplier: z.number().min(0.5).max(1.5)
}).strict();

export const dailyMenuTemplateVersionSchema = z.object({
  id: traceableIdSchema,
  datasetVersion: traceableIdSchema,
  sourceId: traceableIdSchema,
  reviewedAt: z.iso.datetime(),
  qualityStatus: z.enum(['reviewed', 'test_fixture']),
  meals: z.array(z.object({
    slot: mealSlotSchema,
    recipeTemplateVersionId: traceableIdSchema
  }).strict()).min(3).max(4)
}).strict().superRefine((value, context) => {
  const slots = new Set<string>();
  value.meals.forEach((meal, index) => {
    if (slots.has(meal.slot)) {
      context.addIssue({
        code: 'custom',
        path: ['meals', index, 'slot'],
        message: 'daily menu meal slots must be unique'
      });
    }
    slots.add(meal.slot);
  });
  for (const requiredSlot of ['breakfast', 'lunch', 'dinner'] as const) {
    if (!slots.has(requiredSlot)) {
      context.addIssue({
        code: 'custom',
        path: ['meals'],
        message: `daily menu must include exactly one ${requiredSlot}`
      });
    }
  }
});

export const dailyMenuCatalogVersionSchema = z.object({
  id: traceableIdSchema,
  datasetVersion: traceableIdSchema,
  sourceId: traceableIdSchema,
  reviewedAt: z.iso.datetime(),
  qualityStatus: z.enum(['reviewed', 'test_fixture']),
  dailyMenuTemplateVersionIds: z.array(traceableIdSchema).length(7)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.dailyMenuTemplateVersionIds.forEach((id, index) => {
    if (ids.has(id)) {
      context.addIssue({
        code: 'custom',
        path: ['dailyMenuTemplateVersionIds', index],
        message: 'daily menu template version IDs must be unique'
      });
    }
    ids.add(id);
  });
});

export const nutritionPolicySchema = z.object({
  policyVersion: z.literal('nutrition-policy-v1'),
  sourceIds: z.tuple([
    z.literal('CN-DRI-MACRO-2017'),
    z.literal('PROTEIN-MORTON-2018'),
    z.literal('ISSN-PROTEIN-2017')
  ]),
  applicableAgeRange: z.object({
    minInclusive: z.literal(18),
    maxInclusive: z.literal(45)
  }).strict(),
  applicableBmiRange: z.object({
    minInclusive: z.literal(18.5),
    maxExclusive: z.literal(24)
  }).strict(),
  effectiveDate: z.iso.date(),
  reviewedAt: z.iso.date(),
  protein: z.object({
    noTrainingRniG: z.object({ male: z.literal(65), female: z.literal(55) }).strict(),
    generalOrEndurancePerKg: z.literal(1.4),
    resistanceOrMuscleGainPerKg: z.literal(1.6),
    automaticMaxPerKg: z.literal(2)
  }).strict(),
  fatEnergyRange: z.object({
    minInclusive: z.literal(0.2),
    midpoint: z.literal(0.25),
    maxInclusive: z.literal(0.3)
  }).strict(),
  carbohydrateEnergyRange: z.object({
    minInclusive: z.literal(0.5),
    maxInclusive: z.literal(0.65)
  }).strict(),
  carbohydrateMinimumG: z.literal(120),
  fiberRangeG: z.object({ minInclusive: z.literal(25), maxInclusive: z.literal(30) }).strict(),
  saturatedFatEnergyMaxExclusive: z.literal(0.1),
  addedSugarEnergyMaxExclusive: z.literal(0.1),
  kcalPerGram: z.object({
    protein: z.literal(4),
    carbohydrate: z.literal(4),
    fat: z.literal(9)
  }).strict(),
  rounding: z.object({
    grams: z.literal('nearest_tenth_half_up'),
    percentage: z.literal('nearest_tenth_half_up')
  }).strict()
}).strict();

const nutritionConstraintConflictSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('protein_automatic_max_exceeded'),
    proteinG: z.number().positive(),
    maximumG: z.number().positive()
  }).strict(),
  z.object({
    code: z.literal('carbohydrate_minimum_exceeds_share_maximum'),
    minimumG: z.literal(120),
    maximumByEnergyG: z.number().nonnegative()
  }).strict(),
  z.object({
    code: z.literal('macro_energy_intersection_empty'),
    minimumCarbohydrateKcal: z.number().nonnegative(),
    maximumCarbohydrateKcal: z.number()
  }).strict()
]);

export const nutritionTargetResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('feasible'),
    targetEnergyKcal: z.number().int().positive(),
    proteinG: z.number().positive(),
    fatG: z.number().positive(),
    carbohydrateG: z.number().min(120),
    proteinEnergyPercent: z.number().nonnegative().max(100),
    fatEnergyPercent: z.number().min(20).max(30),
    carbohydrateEnergyPercent: z.number().min(50).max(65),
    fiberRangeG: z.object({ minInclusive: z.literal(25), maxInclusive: z.literal(30) }).strict(),
    saturatedFatMaxExclusiveG: z.number().positive(),
    addedSugarMaxExclusiveG: z.number().positive(),
    policy: nutritionPolicySchema
  }).strict(),
  z.object({
    kind: z.literal('infeasible'),
    code: z.literal('nutrition_constraints_infeasible'),
    conflicts: z.array(nutritionConstraintConflictSchema).min(1),
    targetEnergyKcal: z.number().positive(),
    policy: nutritionPolicySchema
  }).strict()
]);
