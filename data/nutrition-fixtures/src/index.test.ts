import { describe, expect, it } from 'vitest';
import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema,
  visionProviderResponseSchema
} from '@fitness/contracts';

async function fixtures() {
  const module: Record<string, unknown> = await import('./index').catch(() => ({}));
  const snapshots = module.TEST_NUTRITION_SNAPSHOTS;
  const templates = module.TEST_RECIPE_TEMPLATES;
  const menus = module.TEST_DAILY_MENU_TEMPLATES;
  const catalog = module.TEST_DAILY_MENU_CATALOG;
  expect(snapshots, 'TEST_NUTRITION_SNAPSHOTS must be exported').toBeInstanceOf(Array);
  expect(templates, 'TEST_RECIPE_TEMPLATES must be exported').toBeInstanceOf(Array);
  expect(menus, 'TEST_DAILY_MENU_TEMPLATES must be exported').toBeInstanceOf(Array);
  expect(catalog, 'TEST_DAILY_MENU_CATALOG must be exported').toBeDefined();
  return {
    snapshots: snapshots as readonly unknown[],
    templates: templates as readonly unknown[],
    menus: menus as readonly unknown[],
    catalog
  };
}

async function balancedFixtures() {
  const module: Record<string, unknown> = await import('./index').catch(() => ({}));
  const snapshots = module.TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS;
  const templates = module.TEST_MEAL_PLANNING_RECIPE_TEMPLATES;
  const menus = module.TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES;
  const catalog = module.TEST_MEAL_PLANNING_DAILY_MENU_CATALOG;
  expect(snapshots, 'TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS must be exported')
    .toBeInstanceOf(Array);
  expect(templates, 'TEST_MEAL_PLANNING_RECIPE_TEMPLATES must be exported')
    .toBeInstanceOf(Array);
  expect(menus, 'TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES must be exported')
    .toBeInstanceOf(Array);
  expect(catalog, 'TEST_MEAL_PLANNING_DAILY_MENU_CATALOG must be exported').toBeDefined();
  return {
    snapshots: snapshots as readonly unknown[],
    templates: templates as readonly unknown[],
    menus: menus as readonly unknown[],
    catalog
  };
}

describe('nutrition test fixtures', () => {
  it('provides a deterministic raw vision response without nutrition or quantity claims', async () => {
    const module: Record<string, unknown> = await import('./index').catch(() => ({}));
    const fixture = visionProviderResponseSchema.parse(module.TEST_INGREDIENT_VISION_RESPONSE);
    expect(fixture).toEqual({
      requestId: 'fixture-vision-request-v1',
      candidates: [{
        providerCandidateId: 'fixture-vision-rice-cooked-v1',
        name: '测试米饭',
        confidence: 0.97,
        foodState: 'cooked'
      }]
    });
    expect(JSON.stringify(fixture)).not.toMatch(
      /grams|energy|protein|fat|carbohydrate|nutritionSnapshotId|foodId|userId/
    );
  });

  it('contains exactly 28 traceable non-production snapshots across all core groups', async () => {
    const { snapshots } = await fixtures();
    const parsed = snapshots.map((snapshot) => nutritionDataSnapshotSchema.parse(snapshot));
    expect(parsed).toHaveLength(28);
    expect(new Set(parsed.map(({ foodGroupId }) => foodGroupId))).toEqual(new Set([
      'grains_tubers', 'vegetables', 'fruit', 'animal_protein',
      'soy_nuts', 'dairy', 'fats', 'other'
    ]));
    expect(parsed.every(({ qualityStatus }) => qualityStatus === 'test_fixture')).toBe(true);
    expect(parsed.every(({ sourceId }) => sourceId === 'FITNESS-TEST-FIXTURE-V2')).toBe(true);
  });

  it('pins every recipe ingredient to exactly one matching snapshot', async () => {
    const { snapshots, templates } = await fixtures();
    const parsedSnapshots = snapshots.map((snapshot) => nutritionDataSnapshotSchema.parse(snapshot));
    const parsedTemplates = templates.map((template) => recipeTemplateVersionSchema.parse(template));
    expect(parsedTemplates.length).toBeGreaterThanOrEqual(28);
    expect(parsedTemplates.every(({ qualityStatus }) => qualityStatus === 'test_fixture')).toBe(true);
    for (const template of parsedTemplates) {
      for (const ingredient of template.ingredients) {
        expect(parsedSnapshots.filter((snapshot) => (
          snapshot.id === ingredient.nutritionSnapshotId
          && snapshot.foodId === ingredient.foodId
        ))).toHaveLength(1);
      }
    }
  });

  it('has seven four-meal menus with daily and weekly food diversity', async () => {
    const { snapshots, templates, menus, catalog } = await fixtures();
    const parsedSnapshots = snapshots.map((snapshot) => nutritionDataSnapshotSchema.parse(snapshot));
    const parsedTemplates = templates.map((template) => recipeTemplateVersionSchema.parse(template));
    const parsedMenus = menus.map((menu) => dailyMenuTemplateVersionSchema.parse(menu));
    const parsedCatalog = dailyMenuCatalogVersionSchema.parse(catalog);
    expect(parsedMenus).toHaveLength(7);
    expect(parsedCatalog.dailyMenuTemplateVersionIds).toHaveLength(7);
    const templatesById = new Map(parsedTemplates.map((template) => [template.id, template]));
    const snapshotsByFoodId = new Map(parsedSnapshots.map((snapshot) => [snapshot.foodId, snapshot]));
    const weeklyFoodIds = new Set<string>();
    for (const menu of parsedMenus) {
      expect(menu.meals).toHaveLength(4);
      const foodIds = new Set<string>();
      for (const meal of menu.meals) {
        const template = templatesById.get(meal.recipeTemplateVersionId);
        expect(template).toBeDefined();
        for (const ingredient of template?.ingredients ?? []) foodIds.add(ingredient.foodId);
      }
      const groups = new Set([...foodIds].map((foodId) => snapshotsByFoodId.get(foodId)?.foodGroupId));
      expect(foodIds.size).toBeGreaterThanOrEqual(12);
      expect(groups.size).toBeGreaterThanOrEqual(5);
      for (const foodId of foodIds) weeklyFoodIds.add(foodId);
    }
    expect(weeklyFoodIds).toEqual(new Set(parsedSnapshots.map((snapshot) => snapshot.foodId)));
  });

  it('keeps the balanced local meal graph on wholly independent immutable identities', async () => {
    const { snapshots, templates, menus, catalog } = await fixtures();
    const rawGraphBeforeBalancedAccess = structuredClone({ snapshots, templates, menus, catalog });
    const {
      snapshots: balancedSnapshots,
      templates: balancedTemplates,
      menus: balancedMenus,
      catalog: balancedCatalog
    } = await balancedFixtures();
    expect({ snapshots, templates, menus, catalog }).toEqual(rawGraphBeforeBalancedAccess);
    const rawSnapshots = snapshots.map((value) => nutritionDataSnapshotSchema.parse(value));
    const rawTemplates = templates.map((value) => recipeTemplateVersionSchema.parse(value));
    const rawMenus = menus.map((value) => dailyMenuTemplateVersionSchema.parse(value));
    const rawCatalog = dailyMenuCatalogVersionSchema.parse(catalog);
    const localSnapshots = balancedSnapshots.map((value) => (
      nutritionDataSnapshotSchema.parse(value)
    ));
    const localTemplates = balancedTemplates.map((value) => (
      recipeTemplateVersionSchema.parse(value)
    ));
    const localMenus = balancedMenus.map((value) => dailyMenuTemplateVersionSchema.parse(value));
    const localCatalog = dailyMenuCatalogVersionSchema.parse(balancedCatalog);

    expect(localSnapshots).toHaveLength(28);
    expect(localTemplates).toHaveLength(28);
    expect(localMenus).toHaveLength(7);
    expect(new Set(localSnapshots.map(({ id }) => id)).size).toBe(28);
    expect(new Set(localTemplates.map(({ id }) => id)).size).toBe(28);
    expect(new Set(localMenus.map(({ id }) => id)).size).toBe(7);
    expect(new Set([
      ...rawSnapshots.map(({ id }) => id),
      ...localSnapshots.map(({ id }) => id)
    ]).size).toBe(56);
    expect(new Set([
      ...rawTemplates.map(({ id }) => id),
      ...localTemplates.map(({ id }) => id)
    ]).size).toBe(56);
    expect(new Set([
      ...rawMenus.map(({ id }) => id),
      ...localMenus.map(({ id }) => id)
    ]).size).toBe(14);
    expect(localCatalog.id).not.toBe(rawCatalog.id);
    expect(localCatalog.datasetVersion).not.toBe(rawCatalog.datasetVersion);
    expect(localCatalog.sourceId).not.toBe(rawCatalog.sourceId);
    expect(new Set([
      ...rawSnapshots.map(({ sourceRecordId }) => sourceRecordId),
      ...localSnapshots.map(({ sourceRecordId }) => sourceRecordId)
    ]).size).toBe(56);
    expect(new Set(localSnapshots.map(({ datasetVersion }) => datasetVersion))).toEqual(
      new Set(['fixture-balanced-meal-planning-2026-08-10'])
    );
    expect(new Set(localSnapshots.map(({ sourceId }) => sourceId))).toEqual(
      new Set(['FITNESS-TEST-FIXTURE-BALANCED-MEAL-V1'])
    );
    expect(rawSnapshots.find(({ foodId }) => foodId === 'fixture-rice')?.nutrientsPer100g.energyKcal)
      .toBe(116);
    expect(localSnapshots.find(({ foodId }) => foodId === 'fixture-rice')?.nutrientsPer100g.energyKcal)
      .toBe(160);

    const localSnapshotsById = new Map(localSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const localTemplatesById = new Map(localTemplates.map((template) => [template.id, template]));
    const localMenusById = new Map(localMenus.map((menu) => [menu.id, menu]));
    expect(localSnapshotsById.size).toBe(28);
    expect(localTemplatesById.size).toBe(28);
    expect(localMenusById.size).toBe(7);
    for (const template of localTemplates) {
      expect(template.id).toMatch(/^recipe-version-fixture-balanced-meal-day-\d+-\w+-v1$/);
      expect(template.qualityStatus).toBe('test_fixture');
      for (const ingredient of template.ingredients) {
        expect(localSnapshotsById.get(ingredient.nutritionSnapshotId)).toMatchObject({
          foodId: ingredient.foodId,
          qualityStatus: 'test_fixture'
        });
      }
    }
    for (const menu of localMenus) {
      expect(menu.id).toMatch(/^daily-menu-version-fixture-balanced-meal-day-\d+-v1$/);
      expect(menu.qualityStatus).toBe('test_fixture');
      for (const meal of menu.meals) {
        expect(localTemplatesById.has(meal.recipeTemplateVersionId)).toBe(true);
      }
    }
    expect(localCatalog.dailyMenuTemplateVersionIds).toHaveLength(7);
    for (const menuId of localCatalog.dailyMenuTemplateVersionIds) {
      expect(localMenusById.has(menuId)).toBe(true);
    }

    const combinedSnapshots = [...rawSnapshots, ...localSnapshots];
    expect(new Set(combinedSnapshots.map(({ id }) => id)).size).toBe(combinedSnapshots.length);
    expect(localSnapshots.map(({ id }) => id)).toEqual([
      'snapshot-fixture-balanced-meal-rice-v1',
      'snapshot-fixture-balanced-meal-oats-v1',
      'snapshot-fixture-balanced-meal-sweet-potato-v1',
      'snapshot-fixture-balanced-meal-corn-v1',
      'snapshot-fixture-balanced-meal-broccoli-v1',
      'snapshot-fixture-balanced-meal-spinach-v1',
      'snapshot-fixture-balanced-meal-carrot-v1',
      'snapshot-fixture-balanced-meal-tomato-v1',
      'snapshot-fixture-balanced-meal-mushroom-v1',
      'snapshot-fixture-balanced-meal-cabbage-v1',
      'snapshot-fixture-balanced-meal-apple-v1',
      'snapshot-fixture-balanced-meal-banana-v1',
      'snapshot-fixture-balanced-meal-orange-v1',
      'snapshot-fixture-balanced-meal-blueberry-v1',
      'snapshot-fixture-balanced-meal-chicken-v1',
      'snapshot-fixture-balanced-meal-beef-v1',
      'snapshot-fixture-balanced-meal-egg-v1',
      'snapshot-fixture-balanced-meal-fish-v1',
      'snapshot-fixture-balanced-meal-tofu-v1',
      'snapshot-fixture-balanced-meal-soybean-v1',
      'snapshot-fixture-balanced-meal-peanut-v1',
      'snapshot-fixture-balanced-meal-walnut-v1',
      'snapshot-fixture-balanced-meal-milk-v1',
      'snapshot-fixture-balanced-meal-yogurt-v1',
      'snapshot-fixture-balanced-meal-canola-oil-v1',
      'snapshot-fixture-balanced-meal-sesame-oil-v1',
      'snapshot-fixture-balanced-meal-seaweed-v1',
      'snapshot-fixture-balanced-meal-sesame-v1'
    ]);
  });
});
