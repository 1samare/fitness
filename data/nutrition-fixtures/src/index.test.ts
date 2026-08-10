import { describe, expect, it } from 'vitest';
import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema
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

describe('nutrition test fixtures', () => {
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
});
