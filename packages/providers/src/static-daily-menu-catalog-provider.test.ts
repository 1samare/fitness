import { describe, expect, it } from 'vitest';
import { StaticDailyMenuCatalogProvider } from './static-daily-menu-catalog-provider';

const menus = Array.from({ length: 7 }, (_, index) => ({
  id: `daily-menu-version-fixture-day-${String(index + 1)}-v1`,
  datasetVersion: 'fixture-2026-08-10',
  sourceId: 'FITNESS-TEST-FIXTURE-V2',
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture' as const,
  meals: [
    { slot: 'breakfast' as const, recipeTemplateVersionId: `recipe-fixture-${String(index)}-breakfast-v1` },
    { slot: 'lunch' as const, recipeTemplateVersionId: `recipe-fixture-${String(index)}-lunch-v1` },
    { slot: 'dinner' as const, recipeTemplateVersionId: `recipe-fixture-${String(index)}-dinner-v1` },
    { slot: 'snack' as const, recipeTemplateVersionId: `recipe-fixture-${String(index)}-snack-v1` }
  ]
}));

const catalog = {
  id: 'daily-menu-catalog-fixture-week-v1',
  datasetVersion: 'fixture-2026-08-10',
  sourceId: 'FITNESS-TEST-FIXTURE-V2',
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture' as const,
  dailyMenuTemplateVersionIds: menus.map((menu) => menu.id)
};

describe('StaticDailyMenuCatalogProvider', () => {
  it('rejects fixture menus in production mode', async () => {
    const provider = new StaticDailyMenuCatalogProvider({
      mode: 'production',
      catalog,
      menus
    });
    await expect(provider.getActiveCatalog()).rejects.toMatchObject({
      code: 'daily_menu_catalog_unavailable'
    });
  });

  it('returns cloned reviewed menu records in test mode', async () => {
    const provider = new StaticDailyMenuCatalogProvider({
      mode: 'test',
      catalog,
      menus
    });
    const activeCatalog = await provider.getActiveCatalog();
    const firstMenuId = activeCatalog.dailyMenuTemplateVersionIds[0];
    if (firstMenuId === undefined) throw new Error('fixture catalog must contain a menu');
    const first = await provider.getMenuByVersionId(firstMenuId);
    (first.meals as { slot: string; recipeTemplateVersionId: string }[])[0] = {
      slot: 'snack',
      recipeTemplateVersionId: 'changed'
    };
    expect((await provider.getMenuByVersionId(firstMenuId)).meals[0]?.slot).toBe('breakfast');
  });
});
