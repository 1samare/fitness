import { describe, expect, it } from 'vitest';
import { DuplicateReviewedRecordError } from './reviewed-records';
import {
  InvalidRecipeTemplateError,
  StaticRecipeTemplateProvider
} from './static-recipe-template-provider';

const fixtureTemplate = {
  id: 'recipe-version-fixture-bowl-v1',
  templateId: 'recipe-fixture-bowl',
  version: 1,
  dishNameZh: '测试三色碗',
  sourceId: 'FITNESS-TEST-FIXTURE-V1',
  datasetVersion: 'fixture-2026-08-10',
  reviewedAt: '2026-08-10T00:00:00.000Z',
  qualityStatus: 'test_fixture',
  ingredients: [{
    foodId: 'fixture-tofu',
    nutritionSnapshotId: 'snapshot-fixture-tofu-v1',
    grams: 50
  }]
};

describe('StaticRecipeTemplateProvider', () => {
  it('serves cloned fixture templates only in test mode', async () => {
    const provider = new StaticRecipeTemplateProvider({
      mode: 'test',
      templates: [fixtureTemplate]
    });
    const first = await provider.getByVersionId(fixtureTemplate.id);
    expect(first).toEqual(fixtureTemplate);
    (first as { dishNameZh: string }).dishNameZh = '已修改';
    expect((await provider.getByVersionId(fixtureTemplate.id)).dishNameZh).toBe('测试三色碗');
  });

  it('rejects malformed and duplicate template versions at construction', () => {
    expect(() => new StaticRecipeTemplateProvider({
      mode: 'test',
      templates: [{ ...fixtureTemplate, ingredients: [] }]
    })).toThrowError(InvalidRecipeTemplateError);
    expect(() => new StaticRecipeTemplateProvider({
      mode: 'test',
      templates: [fixtureTemplate, { ...fixtureTemplate }]
    })).toThrowError(DuplicateReviewedRecordError);
  });

  it('rejects test fixtures and missing versions in production mode', async () => {
    const provider = new StaticRecipeTemplateProvider({
      mode: 'production',
      templates: [fixtureTemplate]
    });
    await expect(provider.getByVersionId(fixtureTemplate.id)).rejects.toMatchObject({
      code: 'recipe_template_unavailable',
      versionId: fixtureTemplate.id
    });
    await expect(provider.getByVersionId('missing')).rejects.toMatchObject({
      code: 'recipe_template_unavailable',
      versionId: 'missing'
    });
  });
});
