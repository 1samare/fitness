import { z } from 'zod';

export const ingredientPhotoMediaTypeSchema = z.enum(['image/jpeg', 'image/png']);
export const ingredientPhotoWorkflowStatusSchema = z.enum([
  'awaiting_upload', 'uploaded', 'recognized', 'recognition_failed', 'confirmed'
]);
export const ingredientPhotoStorageStatusSchema = z.enum([
  'retained', 'cleanup_pending', 'cleanup_failed', 'deleted'
]);

export const visionCandidateSchema = z.object({
  providerCandidateId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(40),
  confidence: z.number().finite().min(0).max(1),
  foodState: z.enum(['raw', 'cooked', 'dry', 'unknown'])
}).strict();

export const visionProviderResponseSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  candidates: z.array(visionCandidateSchema).max(5),
  estimatedCostUnits: z.number().finite().nonnegative().optional()
}).strict();

export const normalizedIngredientCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  foodId: z.string().min(1).max(200),
  nutritionSnapshotId: z.string().min(1).max(200),
  canonicalNameZh: z.string().trim().min(1).max(120),
  confidence: z.number().finite().min(0).max(1),
  foodState: z.enum(['raw', 'cooked', 'dry'])
}).strict();

export const storedIngredientPhotoVersionSchema = z.object({
  kind: z.literal('ingredient_photo_version'),
  id: z.string().min(1).max(200),
  photoId: z.string().min(1).max(200),
  userId: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  uploadCreatedAt: z.iso.datetime(),
  deleteDueAt: z.iso.datetime(),
  expectedCloudPath: z.string().min(1).max(1_024),
  expectedPrivateFileId: z.string().min(10).max(1_024).regex(/^cloud:\/\//),
  mediaType: ingredientPhotoMediaTypeSchema,
  workflowStatus: ingredientPhotoWorkflowStatusSchema,
  storageStatus: ingredientPhotoStorageStatusSchema,
  candidates: z.array(normalizedIngredientCandidateSchema).max(5),
  confirmedCandidateId: z.string().min(1).max(200).nullable(),
  confirmedGrams: z.number().int().positive().max(1_000_000).nullable(),
  inventoryVersionId: z.string().min(1).max(200).nullable(),
  recognitionFailureCode: z.literal('no_supported_candidate').nullable(),
  cleanupAttemptCount: z.number().int().nonnegative(),
  nextCleanupAt: z.iso.datetime().nullable(),
  lastCleanupFailureCode: z.literal('storage_unavailable').nullable(),
  deletedAt: z.iso.datetime().nullable()
}).strict();

export const ingredientPhotoVersionSchema = storedIngredientPhotoVersionSchema;

export const publicIngredientCandidateSchema = normalizedIngredientCandidateSchema
  .omit({ nutritionSnapshotId: true })
  .strict();

export const publicIngredientPhotoSchema = z.object({
  photoId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  workflowStatus: ingredientPhotoWorkflowStatusSchema,
  storageStatus: ingredientPhotoStorageStatusSchema,
  deleteDueAt: z.iso.datetime(),
  candidates: z.array(publicIngredientCandidateSchema).max(5),
  confirmedCandidateId: z.string().min(1).max(200).nullable(),
  inventoryVersionId: z.string().min(1).max(200).nullable()
}).strict();

export type PublicIngredientPhoto = z.infer<typeof publicIngredientPhotoSchema>;
