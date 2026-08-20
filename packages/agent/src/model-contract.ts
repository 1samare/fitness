import { z } from 'zod';

const moveTrainingEvidenceSchema = z.object({
  kind: z.literal('command'),
  intent: z.literal('move_training_day'),
  evidence: z.object({
    sourceDateText: z.string().min(1),
    targetDateText: z.string().min(1)
  }).strict()
}).strict();

const replaceMealEvidenceSchema = z.object({
  kind: z.literal('command'),
  intent: z.literal('replace_meal'),
  evidence: z.object({
    businessDateText: z.string().min(1),
    mealSlotText: z.string().min(1),
    dishNameText: z.string().min(1)
  }).strict()
}).strict();

const resizeMealEvidenceSchema = z.object({
  kind: z.literal('command'),
  intent: z.literal('resize_meal_portion'),
  evidence: z.object({
    businessDateText: z.string().min(1),
    mealSlotText: z.string().min(1),
    multiplierText: z.string().min(1)
  }).strict()
}).strict();

const clarifySchema = z.discriminatedUnion('intent', [
  z.object({
    kind: z.literal('clarify'),
    intent: z.literal('move_training_day'),
    missingFields: z.array(z.enum(['source_date', 'target_date'])).min(1)
  }).strict(),
  z.object({
    kind: z.literal('clarify'),
    intent: z.literal('replace_meal'),
    missingFields: z.array(z.enum(['business_date', 'meal_slot', 'dish_name'])).min(1)
  }).strict(),
  z.object({
    kind: z.literal('clarify'),
    intent: z.literal('resize_meal_portion'),
    missingFields: z.array(z.enum(['business_date', 'meal_slot', 'multiplier'])).min(1)
  }).strict()
]);

const rejectSchema = z.object({
  kind: z.literal('reject'),
  reason: z.enum(['unsupported_request', 'unsafe_or_prohibited'])
}).strict();

export const rawAssistantDecisionSchema = z.union([
  moveTrainingEvidenceSchema,
  replaceMealEvidenceSchema,
  resizeMealEvidenceSchema,
  clarifySchema,
  rejectSchema
]);

export type RawAssistantDecision = z.infer<typeof rawAssistantDecisionSchema>;

export type AssistantModelRepairFeedback =
  | 'invalid_json_or_schema'
  | 'evidence_not_explicit'
  | 'unsupported_parameter';

export interface AssistantLanguageModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AssistantLanguageModelInput {
  readonly systemPrompt: string;
  readonly messages: readonly AssistantLanguageModelMessage[];
  readonly repairAttempt: 0 | 1;
  readonly repairFeedback?: AssistantModelRepairFeedback;
  readonly repairPrompt?: string;
}

export interface AssistantLanguageModelResult {
  readonly rawText: string;
  readonly requestId?: string;
}

export interface AssistantLanguageModelProvider {
  generateIntent(input: AssistantLanguageModelInput): Promise<AssistantLanguageModelResult>;
}
