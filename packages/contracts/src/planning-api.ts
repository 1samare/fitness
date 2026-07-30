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

const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const businessTimezoneSchema = z.string().min(3).max(64).regex(/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/);
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function writeEnvelopeSchema<TSchema extends z.ZodType>(payloadSchema: TSchema) {
  return z.object({
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
    payload: payloadSchema
  }).strict();
}

const bodyProfilePayloadSchema = z.object({
  ageYears: z.number().int().min(18).max(120),
  sexCode: z.union([z.literal(0), z.literal(1)]),
  heightCm: z.number().min(100).max(250),
  weightKg: z.number().min(25).max(300),
  healthScopeConfirmed: z.boolean(),
  nonTrainingActivity: z.enum(['light', 'moderate', 'heavy']),
  allergens: z.array(z.string().trim().min(1).max(80)).max(50),
  avoidFoods: z.array(z.string().trim().min(1).max(80)).max(50),
  dietPreferences: z.array(z.string().trim().min(1).max(80)).max(50),
  businessTimezone: businessTimezoneSchema
}).strict();

const goalPayloadSchema = z.object({
  goal: z.enum(['maintain', 'fat_loss', 'muscle_gain']),
  targetWeightKg: z.number().min(25).max(300).optional(),
  effectiveDate: businessDateSchema,
  targetDate: businessDateSchema
}).strict().refine(
  (value) => value.targetDate >= value.effectiveDate,
  { path: ['targetDate'], message: 'targetDate must not precede effectiveDate' }
);

const trainingPlanPayloadSchema = z.object({
  weekStartDate: businessDateSchema,
  businessTimezone: businessTimezoneSchema,
  sessions: z.array(z.object({
    businessDate: businessDateSchema,
    sessionCode: z.string().regex(/^\d{5}$/),
    durationMinutes: z.number().positive().max(300)
  }).strict()).max(7)
}).strict();

export const planningApiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('health') }).strict(),
  z.object({
    action: z.literal('previewDailyEnergy'),
    payload: previewPayloadSchema
  }).strict(),
  z.object({
    action: z.literal('saveBodyProfile'),
    payload: writeEnvelopeSchema(bodyProfilePayloadSchema)
  }).strict(),
  z.object({
    action: z.literal('saveGoal'),
    payload: writeEnvelopeSchema(goalPayloadSchema)
  }).strict(),
  z.object({
    action: z.literal('saveTrainingPlan'),
    payload: writeEnvelopeSchema(trainingPlanPayloadSchema)
  }).strict(),
  z.object({ action: z.literal('getCurrentContext') }).strict()
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

const supportedBmiSchema = z.number().min(18.5).max(24);
const unsupportedBmiSchema = z.number().positive().max(300);
const positiveKcalSchema = z.number().int().positive();
const nonNegativeKcalSchema = z.number().int().nonnegative();

const supportedDataSchema = z.object({
  kind: z.literal('supported'),
  bmi: supportedBmiSchema,
  estimatedBmrKcal: positiveKcalSchema,
  nonTrainingBaselineKcal: positiveKcalSchema,
  trainingNetKcal: nonNegativeKcalSchema,
  estimatedMaintenanceKcal: positiveKcalSchema,
  targetEnergyKcal: positiveKcalSchema,
  policy: policyMetadataSchema,
  disclaimer: z.string().min(1)
}).strict();

const unsupportedDataSchema = z.object({
  kind: z.literal('unsupported'),
  code: z.literal('unsupported_for_personalized_energy'),
  reasons: z.array(unsupportedReasonSchema).min(1),
  bmi: unsupportedBmiSchema,
  policy: policyMetadataSchema
}).strict();

const energyResultSchema = z.discriminatedUnion('kind', [
  supportedDataSchema,
  unsupportedDataSchema
]);

const versionMetadataSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime()
});

const bodyProfileVersionSchema = versionMetadataSchema.extend({
  kind: z.literal('body_profile_version'),
  payload: bodyProfilePayloadSchema
}).strict();

const goalVersionSchema = versionMetadataSchema.extend({
  kind: z.literal('goal_version'),
  bodyProfileVersionId: z.string().min(1),
  payload: goalPayloadSchema
}).strict();

const trainingPlanVersionSchema = versionMetadataSchema.extend({
  kind: z.literal('training_plan_version'),
  bodyProfileVersionId: z.string().min(1),
  goalVersionId: z.string().min(1),
  payload: trainingPlanPayloadSchema
}).strict();

const dailyEnergyTargetVersionSchema = versionMetadataSchema.extend({
  kind: z.literal('daily_energy_target_version'),
  businessDate: businessDateSchema,
  bodyProfileVersionId: z.string().min(1),
  goalVersionId: z.string().min(1),
  trainingPlanVersionId: z.string().min(1),
  energyPolicyVersion: z.literal('calculation-policy-v2'),
  energy: energyResultSchema
}).strict();

const bodyProfileSavedSchema = z.object({
  kind: z.literal('body_profile_saved'),
  version: bodyProfileVersionSchema
}).strict();

const goalSavedSchema = z.object({
  kind: z.literal('goal_saved'),
  version: goalVersionSchema
}).strict();

const trainingPlanSavedSchema = z.object({
  kind: z.literal('training_plan_saved'),
  trainingPlan: trainingPlanVersionSchema,
  dailyEnergyTargets: z.array(dailyEnergyTargetVersionSchema).length(7)
}).strict();

const currentContextSchema = z.object({
  kind: z.literal('current_context'),
  bodyProfile: bodyProfileVersionSchema.nullable(),
  goal: goalVersionSchema.nullable(),
  trainingPlan: trainingPlanVersionSchema.nullable(),
  dailyEnergyTargets: z.array(dailyEnergyTargetVersionSchema)
}).strict();

const successfulDataSchema = z.discriminatedUnion('kind', [
  healthDataSchema,
  supportedDataSchema,
  unsupportedDataSchema,
  bodyProfileSavedSchema,
  goalSavedSchema,
  trainingPlanSavedSchema,
  currentContextSchema
]);

const apiErrorSchema = z.object({
  code: z.enum([
    'invalid_request',
    'unknown_action',
    'unknown_training_session',
    'unauthenticated',
    'version_conflict',
    'idempotency_key_reused',
    'planning_prerequisite_missing',
    'invalid_goal',
    'invalid_training_plan',
    'internal_error'
  ]),
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
