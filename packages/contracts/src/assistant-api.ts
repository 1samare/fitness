import { z } from 'zod';
import { businessDateSchema } from './business-date';

const idSchema = z.string().trim().min(1).max(128);
const idempotencyKeySchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const requestFingerprintSchema = z.string().regex(/^v2:sha256:[0-9a-f]{64}$/);
const mealSlotSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
const assistantIntentSchema = z.enum([
  'move_training_day',
  'replace_meal',
  'resize_meal_portion'
]);
const missingFieldSchema = z.enum([
  'source_date',
  'target_date',
  'business_date',
  'meal_slot',
  'dish_name',
  'multiplier'
]);
const recoveryActionSchema = z.enum([
  'none',
  'retry',
  'open_training_plan',
  'open_meal_plan',
  'review_meal_plan_changes'
]);

function hasExactlyMissingFields(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every((field) => actual.includes(field));
}

const moveTrainingCommandSchema = z.object({
  kind: z.literal('move_training_day'),
  sourceDate: businessDateSchema,
  targetDate: businessDateSchema
}).strict();

const replaceMealCommandSchema = z.object({
  kind: z.literal('replace_meal'),
  businessDate: businessDateSchema,
  slot: mealSlotSchema,
  dishNameZh: z.string().trim().min(1).max(120)
}).strict();

const servingMultiplierSchema = z.number()
  .min(0.5)
  .max(1.5)
  .refine((value) => Math.abs(value * 20 - Math.round(value * 20)) < 1e-9, {
    message: 'multiplier must use a 0.05 step'
  });

const resizeMealPortionCommandSchema = z.object({
  kind: z.literal('resize_meal_portion'),
  businessDate: businessDateSchema,
  slot: mealSlotSchema,
  multiplier: servingMultiplierSchema
}).strict();

export const assistantValidatedCommandSchema = z.discriminatedUnion('kind', [
  moveTrainingCommandSchema,
  replaceMealCommandSchema,
  resizeMealPortionCommandSchema
]);

const moveTrainingClarificationSchema = z.object({
  intent: z.literal('move_training_day'),
  sourceDate: businessDateSchema.nullable(),
  targetDate: businessDateSchema.nullable(),
  missingFields: z.array(z.enum(['source_date', 'target_date'])).min(1).max(2)
}).strict().refine((value) => hasExactlyMissingFields(value.missingFields, [
  ...(value.sourceDate === null ? ['source_date'] : []),
  ...(value.targetDate === null ? ['target_date'] : [])
]), {
  path: ['missingFields'],
  message: 'missing fields must match unvalidated values'
});

const replaceMealClarificationSchema = z.object({
  intent: z.literal('replace_meal'),
  businessDate: businessDateSchema.nullable(),
  slot: mealSlotSchema.nullable(),
  dishNameZh: z.string().trim().min(1).max(120).nullable(),
  missingFields: z.array(z.enum(['business_date', 'meal_slot', 'dish_name'])).min(1).max(3)
}).strict().refine((value) => hasExactlyMissingFields(value.missingFields, [
  ...(value.businessDate === null ? ['business_date'] : []),
  ...(value.slot === null ? ['meal_slot'] : []),
  ...(value.dishNameZh === null ? ['dish_name'] : [])
]), {
  path: ['missingFields'],
  message: 'missing fields must match unvalidated values'
});

const resizeMealPortionClarificationSchema = z.object({
  intent: z.literal('resize_meal_portion'),
  businessDate: businessDateSchema.nullable(),
  slot: mealSlotSchema.nullable(),
  multiplier: servingMultiplierSchema.nullable(),
  missingFields: z.array(z.enum(['business_date', 'meal_slot', 'multiplier'])).min(1).max(3)
}).strict().refine((value) => hasExactlyMissingFields(value.missingFields, [
  ...(value.businessDate === null ? ['business_date'] : []),
  ...(value.slot === null ? ['meal_slot'] : []),
  ...(value.multiplier === null ? ['multiplier'] : [])
]), {
  path: ['missingFields'],
  message: 'missing fields must match unvalidated values'
});

export const assistantPendingClarificationSchema = z.discriminatedUnion('intent', [
  moveTrainingClarificationSchema,
  replaceMealClarificationSchema,
  resizeMealPortionClarificationSchema
]);

export const assistantTurnResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command_executed'),
    command: assistantIntentSchema,
    message: z.string().trim().min(1).max(500),
    recoveryAction: recoveryActionSchema
  }).strict(),
  z.object({
    kind: z.literal('clarification_required'),
    missingFields: z.array(missingFieldSchema).min(1).max(3),
    pendingClarification: assistantPendingClarificationSchema,
    message: z.string().trim().min(1).max(500)
  }).strict(),
  z.object({
    kind: z.literal('request_rejected'),
    reason: z.enum(['unsupported_request', 'unsafe_or_prohibited']),
    message: z.string().trim().min(1).max(500)
  }).strict(),
  z.object({
    kind: z.literal('assistant_unavailable'),
    reason: z.enum(['model_output_invalid', 'provider_unavailable', 'internal_error']),
    message: z.string().trim().min(1).max(500),
    recoveryAction: recoveryActionSchema
  }).strict(),
  z.object({
    kind: z.literal('command_rejected'),
    reason: z.enum([
      'request_not_allowed',
      'command_rejected',
      'nutrition_constraints_infeasible'
    ]),
    message: z.string().trim().min(1).max(500),
    recoveryAction: recoveryActionSchema
  }).strict()
]);

export const assistantConversationMessageSchema = z.object({
  turnId: idSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(2_000),
  createdAt: z.iso.datetime()
}).strict();

const pendingTurnBase = {
  turnId: idSchema,
  idempotencyKey: idempotencyKeySchema,
  requestFingerprint: requestFingerprintSchema,
  expectedVersion: z.number().int().nonnegative(),
  message: z.string().trim().min(1).max(2_000),
  startedAt: z.iso.datetime()
};

export const assistantPendingTurnSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('received'),
    ...pendingTurnBase
  }).strict(),
  z.object({
    status: z.literal('validated'),
    ...pendingTurnBase,
    command: assistantValidatedCommandSchema
  }).strict()
]);

export const assistantTurnReceiptSchema = z.object({
  turnId: idSchema,
  idempotencyKey: idempotencyKeySchema,
  requestFingerprint: requestFingerprintSchema,
  conversationVersion: z.number().int().positive(),
  completedAt: z.iso.datetime(),
  result: assistantTurnResultSchema
}).strict();

export const assistantConversationSummarySchema = z.object({
  activeWeekStartDate: businessDateSchema.nullable(),
  trainingPlanVersion: z.number().int().nonnegative(),
  mealPlanVersion: z.number().int().nonnegative(),
  lockedMealDates: z.array(businessDateSchema).max(7),
  pendingClarification: assistantPendingClarificationSchema.nullable()
}).strict();

export const assistantConversationStateSchema = z.object({
  version: z.number().int().nonnegative(),
  recentMessages: z.array(assistantConversationMessageSchema).max(12),
  summary: assistantConversationSummarySchema,
  pendingTurn: assistantPendingTurnSchema.nullable(),
  recentReceipts: z.array(assistantTurnReceiptSchema).max(32)
}).strict();

export const assistantApiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('getAssistantConversation') }).strict(),
  z.object({
    action: z.literal('sendAssistantMessage'),
    payload: z.object({
      expectedVersion: z.number().int().nonnegative(),
      idempotencyKey: idempotencyKeySchema,
      message: z.string().trim().min(1).max(2_000)
    }).strict()
  }).strict()
]);

const publicPendingTurnSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
  message: z.string().trim().min(1).max(2_000)
}).strict();

const supportedCommandsSchema = z.tuple([
  z.literal('move_training_day'),
  z.literal('replace_meal'),
  z.literal('resize_meal_portion')
]);

const assistantConversationDataSchema = z.object({
  kind: z.literal('assistant_conversation'),
  conversationVersion: z.number().int().nonnegative(),
  messages: z.array(assistantConversationMessageSchema).max(12),
  pendingTurn: publicPendingTurnSchema.nullable(),
  supportedCommands: supportedCommandsSchema
}).strict();

const assistantTurnCompletedDataSchema = z.object({
  kind: z.literal('assistant_turn_completed'),
  conversationVersion: z.number().int().nonnegative(),
  result: assistantTurnResultSchema
}).strict();

export const assistantApiErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthenticated',
  'conversation_version_conflict',
  'conversation_busy',
  'model_output_invalid',
  'request_not_allowed',
  'provider_unavailable',
  'command_rejected',
  'nutrition_constraints_infeasible',
  'internal_error'
]);

const assistantApiErrorSchema = z.object({
  code: assistantApiErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
  recoveryAction: recoveryActionSchema,
  issues: z.array(z.object({
    path: z.string().max(200),
    message: z.string().max(500)
  }).strict()).max(20).optional()
}).strict();

export const assistantApiResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z.discriminatedUnion('kind', [
      assistantConversationDataSchema,
      assistantTurnCompletedDataSchema
    ])
  }).strict(),
  z.object({ success: z.literal(false), error: assistantApiErrorSchema }).strict()
]);

export type AssistantApiRequest = z.infer<typeof assistantApiRequestSchema>;
export type AssistantApiResponse = z.infer<typeof assistantApiResponseSchema>;
export type AssistantConversationStateDto = z.infer<typeof assistantConversationStateSchema>;
