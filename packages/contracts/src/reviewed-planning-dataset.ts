import { z } from 'zod';
import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema,
  nutritionDataSnapshotSchema,
  recipeTemplateVersionSchema,
  traceableIdSchema
} from './nutrition';

const reviewedDatasetSourceReferenceSchema = z.object({
  sourceId: traceableIdSchema,
  title: z.string().trim().min(1).max(500),
  version: traceableIdSchema,
  authorizationEvidenceRef: z.string().trim().min(1).max(500),
  cacheAllowed: z.literal(true),
  displayAllowed: z.literal(true),
  authorizationValidUntil: z.iso.datetime().nullable(),
  noExpiryBasis: z.string().trim().min(1).max(500).nullable(),
  exitDisposition: z.literal('retain_historical_only')
}).strict().superRefine((value, context) => {
  const hasExpiry = value.authorizationValidUntil !== null;
  const hasNoExpiryBasis = value.noExpiryBasis !== null;
  if (hasExpiry === hasNoExpiryBasis) {
    context.addIssue({
      code: 'custom',
      path: ['authorizationValidUntil'],
      message: 'exactly one authorization expiry or no-expiry basis is required'
    });
  }
});

export const reviewedPlanningDatasetV1Schema = z.object({
  schemaVersion: z.literal('reviewed-planning-dataset-v1'),
  datasetId: traceableIdSchema,
  datasetVersion: traceableIdSchema,
  approvalStatus: z.literal('approved'),
  qualityStatus: z.literal('reviewed'),
  activatedAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceReferences: z.array(reviewedDatasetSourceReferenceSchema).min(1).max(1_000),
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
      if (record.qualityStatus !== 'reviewed') {
        context.addIssue({
          code: 'custom',
          path: [collectionName, index, 'qualityStatus'],
          message: 'production dataset records must be reviewed'
        });
      }
    });
  }
});

export type ReviewedPlanningDatasetV1 = z.infer<typeof reviewedPlanningDatasetV1Schema>;
export type ReviewedDatasetSourceReference = z.infer<typeof reviewedDatasetSourceReferenceSchema>;
