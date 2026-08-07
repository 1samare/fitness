import { z } from 'zod';
import { businessDateSchema } from './business-date';

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

export const planningSetupPayloadSchema = z.object({
  bodyProfile: bodyProfilePayloadSchema,
  goal: goalPayloadSchema,
  trainingPlan: trainingPlanPayloadSchema
}).strict();

const latestPlanningVersionsSchema = z.object({
  bodyProfile: z.number().int().nonnegative(),
  goal: z.number().int().nonnegative(),
  trainingPlan: z.number().int().nonnegative()
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
  z.object({
    action: z.literal('completePlanningSetup'),
    payload: planningSetupPayloadSchema.extend({
      expectedVersions: latestPlanningVersionsSchema,
      idempotencyKey: idempotencyKeySchema
    }).strict()
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
  nutritionPolicyVersion: z.literal('nutrition-policy-v1'),
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
  dailyEnergyTargets: z.array(dailyEnergyTargetVersionSchema).max(7)
}).strict();

const planningSetupCompletedSchema = z.object({
  kind: z.literal('planning_setup_completed'),
  bodyProfile: bodyProfileVersionSchema,
  goal: goalVersionSchema,
  trainingPlan: trainingPlanVersionSchema,
  dailyEnergyTargets: z.array(dailyEnergyTargetVersionSchema).max(7),
  affectedDates: z.array(businessDateSchema).max(7)
}).strict();

const currentContextSchema = z.object({
  kind: z.literal('current_context'),
  bodyProfile: bodyProfileVersionSchema.nullable(),
  goal: goalVersionSchema.nullable(),
  trainingPlan: trainingPlanVersionSchema.nullable(),
  dailyEnergyTargets: z.array(dailyEnergyTargetVersionSchema),
  latestVersions: latestPlanningVersionsSchema
}).strict();

const storedBodyProfileVersionSchema = bodyProfileVersionSchema.extend({
  userId: z.string().min(1)
}).strict();

const storedGoalVersionSchema = goalVersionSchema.extend({
  userId: z.string().min(1)
}).strict();

const storedTrainingPlanVersionSchema = trainingPlanVersionSchema.extend({
  userId: z.string().min(1)
}).strict();

const storedDailyEnergyTargetVersionSchema = dailyEnergyTargetVersionSchema.extend({
  userId: z.string().min(1)
}).strict();

const storedTrainingPlanChangedEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('TrainingPlanChanged'),
  userId: z.string().min(1),
  previousTrainingPlanVersionId: z.string().min(1).nullable(),
  trainingPlanVersionId: z.string().min(1),
  bodyProfileVersionId: z.string().min(1),
  goalVersionId: z.string().min(1),
  affectedDates: z.array(businessDateSchema).max(7),
  occurredAt: z.iso.datetime(),
  status: z.literal('pending')
}).strict();

const idempotencyRecordSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('saveBodyProfile'),
    key: z.string().min(1),
    requestFingerprint: z.string().min(1),
    resultVersionId: z.string().min(1)
  }).strict(),
  z.object({
    operation: z.literal('saveGoal'),
    key: z.string().min(1),
    requestFingerprint: z.string().min(1),
    resultVersionId: z.string().min(1)
  }).strict(),
  z.object({
    operation: z.literal('saveTrainingPlan'),
    key: z.string().min(1),
    requestFingerprint: z.string().min(1),
    resultVersionId: z.string().min(1)
  }).strict(),
  z.object({
    operation: z.literal('completePlanningSetup'),
    key: z.string().min(1),
    requestFingerprint: z.string().min(1),
    resultVersionIds: z.object({
      bodyProfileVersionId: z.string().min(1),
      goalVersionId: z.string().min(1),
      trainingPlanVersionId: z.string().min(1),
      dailyEnergyTargetVersionIds: z.array(z.string().min(1)).max(7),
      eventId: z.string().min(1)
    }).strict()
  }).strict()
]);

export const planningAggregateStateSchema = z.object({
  bodyProfiles: z.array(storedBodyProfileVersionSchema),
  goals: z.array(storedGoalVersionSchema),
  trainingPlans: z.array(storedTrainingPlanVersionSchema),
  dailyEnergyTargets: z.array(storedDailyEnergyTargetVersionSchema),
  outboxEvents: z.array(storedTrainingPlanChangedEventSchema),
  idempotencyRecords: z.array(idempotencyRecordSchema),
  activeBodyProfileVersionId: z.string().min(1).nullable(),
  activeGoalVersionId: z.string().min(1).nullable(),
  activeTrainingPlanVersionId: z.string().min(1).nullable()
}).strict();

const successfulDataSchema = z.discriminatedUnion('kind', [
  healthDataSchema,
  supportedDataSchema,
  unsupportedDataSchema,
  bodyProfileSavedSchema,
  goalSavedSchema,
  trainingPlanSavedSchema,
  planningSetupCompletedSchema,
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
    'invalid_calendar_date',
    'past_training_change_forbidden',
    'training_date_outside_goal_period',
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
export type PlanningSetupPayload = z.infer<typeof planningSetupPayloadSchema>;
export type PlanningApiResponse = z.infer<typeof planningApiResponseSchema>;
