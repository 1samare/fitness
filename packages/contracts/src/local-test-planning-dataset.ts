import { z } from 'zod';
import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema,
  traceableIdSchema
} from './nutrition';

const localTestDatasetSourceReferenceSchema = z.object({
  sourceId: traceableIdSchema,
  title: z.string().trim().min(1).max(500),
  version: traceableIdSchema,
  fixtureNotice: z.literal('synthetic_test_data_only')
}).strict();

export const localTestPlanningDatasetV1Schema = z.object({
  schemaVersion: z.literal('local-test-planning-dataset-v1'),
  datasetId: traceableIdSchema,
  datasetVersion: traceableIdSchema,
  qualityStatus: z.literal('test_fixture'),
  createdAt: z.iso.datetime(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceReferences: z.array(localTestDatasetSourceReferenceSchema).min(1).max(100),
  nutritionSnapshots: z.array(nutritionDataSnapshotSchema).min(1).max(100_000),
  recipeTemplates: z.array(recipeTemplateVersionSchema).min(1).max(100_000),
  dailyMenus: z.array(dailyMenuTemplateVersionSchema).length(7),
  menuCatalog: dailyMenuCatalogVersionSchema
}).strict().superRefine((value, context) => {
  const collections = [
    ['nutritionSnapshots', value.nutritionSnapshots],
    ['recipeTemplates', value.recipeTemplates],
    ['dailyMenus', value.dailyMenus],
    ['menuCatalog', [value.menuCatalog]]
  ] as const;

  for (const [collectionName, records] of collections) {
    records.forEach((record, index) => {
      if (record.qualityStatus !== 'test_fixture') {
        context.addIssue({
          code: 'custom',
          path: [collectionName, index, 'qualityStatus'],
          message: 'local test dataset records must be test_fixture'
        });
      }
    });
  }
});

export type LocalTestPlanningDatasetV1 = z.infer<typeof localTestPlanningDatasetV1Schema>;
export type LocalTestDatasetSourceReference = z.infer<typeof localTestDatasetSourceReferenceSchema>;
