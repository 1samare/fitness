import { createHash } from 'node:crypto';
import type {
  CloudBaseDatabase,
  CloudBaseDocumentReference,
  CloudBaseTransaction
} from '@fitness/persistence';
import { reviewedPlanningDatasetV1Schema } from '@fitness/contracts';
import {
  canonicalReviewedDatasetPayload,
  ReviewedDatasetConfigurationError
} from '@fitness/providers';
import {
  TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
  TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES,
  TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
  TEST_MEAL_PLANNING_RECIPE_TEMPLATES
} from '@fitness/nutrition-fixtures';
import { describe, expect, test } from 'vitest';
import { createCloudRuntimePlanningHandler } from './cloud-runtime-handler';

class FakeDocumentReference implements CloudBaseDocumentReference {
  public constructor(private readonly value: unknown | undefined) {}
  public get(): Promise<{ readonly data?: unknown }> {
    return Promise.resolve(this.value === undefined ? {} : { data: structuredClone(this.value) });
  }
  public set(): Promise<unknown> { return Promise.resolve({}); }
  public remove(): Promise<unknown> { return Promise.resolve({}); }
}

class FakeDatabase implements CloudBaseDatabase, CloudBaseTransaction {
  public readonly reads: string[] = [];
  public constructor(private readonly documents = new Map<string, unknown>()) {}
  public collection(name: string) {
    return {
      doc: (id: string) => {
        const key = `${name}/${id}`;
        this.reads.push(key);
        return new FakeDocumentReference(this.documents.get(key));
      }
    };
  }
  public runTransaction<TResult>(
    operation: (transaction: CloudBaseTransaction) => Promise<TResult>
  ): Promise<TResult> {
    return operation(this);
  }
}

function reviewedDataset() {
  const datasetVersion = 'reviewed-cloud-test-v1';
  const sourceId = 'reviewed-cloud-test-source';
  const reviewedAt = '2026-08-01T00:00:00.000Z';
  const candidate = reviewedPlanningDatasetV1Schema.parse({
    schemaVersion: 'reviewed-planning-dataset-v1' as const,
    datasetId: 'reviewed-planning-cn-v1',
    datasetVersion,
    approvalStatus: 'approved' as const,
    qualityStatus: 'reviewed' as const,
    activatedAt: '2026-08-02T00:00:00.000Z',
    reviewedAt,
    validUntil: '2027-08-01T00:00:00.000Z',
    checksumSha256: '0'.repeat(64),
    sourceReferences: [{
      sourceId,
      title: '合成测试授权来源',
      version: '2026',
      authorizationEvidenceRef: 'private-test-evidence',
      cacheAllowed: true as const,
      displayAllowed: true as const,
      authorizationValidUntil: '2027-08-01T00:00:00.000Z',
      noExpiryBasis: null,
      exitDisposition: 'retain_historical_only' as const
    }],
    nutritionSnapshots: TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS.map((record) => ({
      ...record,
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed' as const,
      allergens: [...record.allergens],
      nutrientsPer100g: { ...record.nutrientsPer100g }
    })),
    recipeTemplates: TEST_MEAL_PLANNING_RECIPE_TEMPLATES.map((record) => ({
      ...record,
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed' as const,
      ingredients: record.ingredients.map((ingredient) => ({ ...ingredient }))
    })),
    dailyMenus: TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES.map((record) => ({
      ...record,
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed' as const,
      meals: record.meals.map((meal) => ({ ...meal }))
    })),
    menuCatalog: {
      ...TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
      sourceId,
      datasetVersion,
      reviewedAt,
      qualityStatus: 'reviewed' as const,
      dailyMenuTemplateVersionIds: [
        ...TEST_MEAL_PLANNING_DAILY_MENU_CATALOG.dailyMenuTemplateVersionIds
      ]
    }
  });
  candidate.checksumSha256 = createHash('sha256')
    .update(canonicalReviewedDatasetPayload(candidate), 'utf8')
    .digest('hex');
  return candidate;
}

describe('cloud planning runtime reviewed dataset composition', () => {
  test.each([undefined, '', '   '])('rejects missing or blank dataset ID: %s', (datasetId) => {
    expect(() => createCloudRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      environment: { FITNESS_REVIEWED_DATASET_ID: datasetId }
    })).toThrow(ReviewedDatasetConfigurationError);
  });

  test('reads exactly the configured document and resolves reviewed food data', async () => {
    const datasetId = 'reviewed-planning-cn-v1';
    const dataset = reviewedDataset();
    const expectedSnapshot = dataset.nutritionSnapshots[0]!;
    const database = new FakeDatabase(new Map([
      [`planning_reviewed_datasets/${datasetId}`, dataset]
    ]));
    const handler = createCloudRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: { FITNESS_REVIEWED_DATASET_ID: datasetId },
      now: () => '2026-08-20T00:00:00.000Z'
    });

    await expect(handler({
      action: 'resolveFoodName',
      payload: { name: expectedSnapshot.canonicalNameZh }
    }, { userId: 'cloud-user' })).resolves.toMatchObject({
      success: true,
      data: {
        resolution: {
          foodId: expectedSnapshot.foodId,
          nutritionSnapshotId: expectedSnapshot.id
        }
      }
    });
    expect(database.reads).toEqual([`planning_reviewed_datasets/${datasetId}`]);
  });

  test('maps invalid dataset contents to the existing public Provider error', async () => {
    const database = new FakeDatabase(new Map([
      ['planning_reviewed_datasets/reviewed-planning-cn-v1', { supplierSecret: 'must-not-leak' }]
    ]));
    const handler = createCloudRuntimePlanningHandler({
      runtimeMode: 'cloud',
      database,
      environment: { FITNESS_REVIEWED_DATASET_ID: 'reviewed-planning-cn-v1' }
    });

    const response = await handler({
      action: 'resolveFoodName',
      payload: { name: '燕麦' }
    }, { userId: 'cloud-user' });
    expect(response).toEqual({
      success: false,
      error: { code: 'provider_unavailable', message: '营养数据暂时不可用。' }
    });
    expect(JSON.stringify(response)).not.toContain('must-not-leak');
  });
});
