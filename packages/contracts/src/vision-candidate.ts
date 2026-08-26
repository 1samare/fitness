import { z } from 'zod';

export const visionCandidateSchema = z.object({
  providerCandidateId: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(100),
  confidence: z.number().min(0).max(1),
  foodState: z.enum(['raw', 'cooked', 'dry', 'unknown'])
}).strict();

export const visionProviderResponseSchema = z.object({
  requestId: z.string().trim().min(1).max(256),
  candidates: z.array(visionCandidateSchema).max(5)
}).strict();

export type VisionCandidate = z.infer<typeof visionCandidateSchema>;
export type VisionProviderResponse = z.infer<typeof visionProviderResponseSchema>;
