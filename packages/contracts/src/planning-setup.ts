import { z } from 'zod';
import { businessDateSchema } from './business-date';

const shortTextSchema = z.string().trim().min(1).max(100);

export const planningSetupPayloadSchema = z.object({
  bodyProfile: z.object({
    ageYears: z.number().int().min(1).max(120),
    sexCode: z.union([z.literal(0), z.literal(1)]),
    heightCm: z.number().positive().max(300),
    weightKg: z.number().positive().max(500),
    healthScopeConfirmed: z.boolean(),
    nonTrainingActivity: z.enum(['light', 'moderate', 'heavy']),
    allergens: z.array(shortTextSchema).max(50),
    avoidFoods: z.array(shortTextSchema).max(50),
    dietPreferences: z.array(shortTextSchema).max(50),
    businessTimezone: z.literal('Asia/Shanghai')
  }).strict(),
  goal: z.object({
    goal: z.enum(['maintain', 'fat_loss', 'muscle_gain']),
    effectiveDate: businessDateSchema,
    targetDate: businessDateSchema,
    targetWeightKg: z.number().positive().max(500).optional()
  }).strict(),
  trainingPlan: z.object({
    weekStartDate: businessDateSchema,
    businessTimezone: z.literal('Asia/Shanghai'),
    sessions: z.array(z.object({
      businessDate: businessDateSchema,
      sessionCode: z.string().trim().min(1).max(32),
      durationMinutes: z.number().positive().max(1_440)
    }).strict()).max(7)
  }).strict()
}).strict();

export type PlanningSetupPayload = z.infer<typeof planningSetupPayloadSchema>;
