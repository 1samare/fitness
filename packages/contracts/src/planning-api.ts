import { z } from 'zod';

const policyMetadataSchema = z.object({
  policyVersion: z.literal('calculation-policy-v2'),
  sourceIds: z.array(z.string().min(1)).min(1),
  applicableAgeRange: z.object({
    minInclusive: z.literal(18),
    maxInclusive: z.literal(45)
  }).strict(),
  applicableBmiRange: z.object({
    minInclusive: z.literal(18.5),
    maxExclusive: z.literal(24)
  }).strict(),
  rounding: z.object({
    kcal: z.literal('nearest_whole_half_up'),
    bmi: z.literal('nearest_hundredth_half_up')
  }).strict()
}).strict();

const previewPayloadSchema = z.object({
  ageYears: z.number().int().min(1).max(120),
  sexCode: z.union([z.literal(0), z.literal(1)]),
  heightCm: z.number().min(100).max(250),
  weightKg: z.number().min(25).max(300),
  healthScopeConfirmed: z.boolean(),
  nonTrainingActivity: z.enum(['light', 'moderate', 'heavy']),
  goal: z.enum(['maintain', 'fat_loss', 'muscle_gain']),
  training: z.object({
    sessionCode: z.string().regex(/^\d{5}$/),
    durationMinutes: z.number().positive().max(300)
  }).strict().optional()
}).strict();

export const planningApiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('health') }).strict(),
  z.object({
    action: z.literal('previewDailyEnergy'),
    payload: previewPayloadSchema
  }).strict()
]);

const unsupportedReasonSchema = z.enum([
  'age_out_of_range',
  'bmi_out_of_range',
  'health_scope_not_confirmed'
]);

const healthDataSchema = z.object({
  kind: z.literal('health'),
  status: z.literal('ok'),
  service: z.literal('planning-api'),
  policyVersion: z.literal('calculation-policy-v2')
}).strict();

const supportedDataSchema = z.object({
  kind: z.literal('supported'),
  bmi: z.number(),
  estimatedBmrKcal: z.number(),
  nonTrainingBaselineKcal: z.number(),
  trainingNetKcal: z.number(),
  estimatedMaintenanceKcal: z.number(),
  targetEnergyKcal: z.number(),
  policy: policyMetadataSchema,
  disclaimer: z.string().min(1)
}).strict();

const unsupportedDataSchema = z.object({
  kind: z.literal('unsupported'),
  code: z.literal('unsupported_for_personalized_energy'),
  reasons: z.array(unsupportedReasonSchema).min(1),
  bmi: z.number(),
  policy: policyMetadataSchema
}).strict();

const successfulDataSchema = z.discriminatedUnion('kind', [
  healthDataSchema,
  supportedDataSchema,
  unsupportedDataSchema
]);

const apiErrorSchema = z.object({
  code: z.enum(['invalid_request', 'unknown_action', 'unknown_training_session', 'internal_error']),
  message: z.string().min(1),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional()
}).strict();

export const planningApiResponseSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: successfulDataSchema }).strict(),
  z.object({ success: z.literal(false), error: apiErrorSchema }).strict()
]);

export type PlanningApiRequest = z.infer<typeof planningApiRequestSchema>;
export type PreviewDailyEnergyRequest = Extract<PlanningApiRequest, { action: 'previewDailyEnergy' }>;
export type PlanningApiResponse = z.infer<typeof planningApiResponseSchema>;
