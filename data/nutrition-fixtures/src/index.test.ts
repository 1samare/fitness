import { describe, expect, it } from 'vitest';
import { nutritionDataSnapshotSchema, recipeTemplateVersionSchema } from '@fitness/contracts';

async function fixtures() {
  const module: Record<string, unknown> = await import('./index').catch(() => ({}));
  const snapshots = module.TEST_NUTRITION_SNAPSHOTS;
  const templates = module.TEST_RECIPE_TEMPLATES;
  expect(snapshots, 'TEST_NUTRITION_SNAPSHOTS must be exported').toBeInstanceOf(Array);
  expect(templates, 'TEST_RECIPE_TEMPLATES must be exported').toBeInstanceOf(Array);
  return {
    snapshots: snapshots as readonly unknown[],
    templates: templates as readonly unknown[]
  };
}

describe('nutrition test fixtures', () => {
  it('contains three traceable non-production snapshots across three food groups', async () => {
    const { snapshots } = await fixtures();
    const parsed = snapshots.map((snapshot) => nutritionDataSnapshotSchema.parse(snapshot));
    expect(parsed).toHaveLength(3);
    expect(new Set(parsed.map(({ foodGroupId }) => foodGroupId))).toHaveLength(3);
    expect(parsed.every(({ qualityStatus }) => qualityStatus === 'test_fixture')).toBe(true);
    expect(parsed.every(({ sourceId }) => sourceId === 'FITNESS-TEST-FIXTURE-V1')).toBe(true);
  });

  it('pins every recipe ingredient to exactly one matching snapshot', async () => {
    const { snapshots, templates } = await fixtures();
    const parsedSnapshots = snapshots.map((snapshot) => nutritionDataSnapshotSchema.parse(snapshot));
    const parsedTemplates = templates.map((template) => recipeTemplateVersionSchema.parse(template));
    expect(parsedTemplates).toHaveLength(1);
    expect(parsedTemplates[0]?.qualityStatus).toBe('test_fixture');
    for (const template of parsedTemplates) {
      for (const ingredient of template.ingredients) {
        expect(parsedSnapshots.filter((snapshot) => (
          snapshot.id === ingredient.nutritionSnapshotId
          && snapshot.foodId === ingredient.foodId
        ))).toHaveLength(1);
      }
    }
  });
});
