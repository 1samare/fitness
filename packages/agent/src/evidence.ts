import type {
  AssistantMissingField,
  AssistantPendingClarification,
  AssistantValidatedCommand,
  MealSlot
} from '@fitness/domain';
import type { z } from 'zod';
import {
  rawAssistantDecisionSchema,
  type AssistantModelRepairFeedback,
  type RawAssistantDecision
} from './model-contract';

export type ValidatedAssistantDecision =
  | { readonly kind: 'command'; readonly command: AssistantValidatedCommand }
  | {
      readonly kind: 'clarify';
      readonly missingFields: readonly AssistantMissingField[];
      readonly pendingClarification: AssistantPendingClarification;
    }
  | {
      readonly kind: 'reject';
      readonly reason: 'unsupported_request' | 'unsafe_or_prohibited';
    };

export type AssistantModelValidation = ValidatedAssistantDecision | {
  readonly kind: 'invalid';
  readonly feedback: AssistantModelRepairFeedback;
};

export interface AssistantEvidenceContext {
  readonly latestMessage: string;
  readonly pendingClarification: AssistantPendingClarification | null;
}

const slotAliases: Readonly<Record<string, MealSlot>> = {
  早餐: 'breakfast',
  早饭: 'breakfast',
  午餐: 'lunch',
  午饭: 'lunch',
  晚餐: 'dinner',
  晚饭: 'dinner',
  加餐: 'snack'
};

function parseIsoDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value
    : null;
}

function parseMultiplier(value: string): number | null {
  const times = /^(\d+(?:\.\d+)?)\s*倍$/.exec(value);
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value);
  const parsed = times !== null
    ? Number(times[1])
    : percent !== null
      ? Number(percent[1]) / 100
      : Number.NaN;
  const hundredths = Math.round(parsed * 100);
  if (!Number.isFinite(parsed)
    || Math.abs(parsed * 100 - hundredths) > 1e-9
    || hundredths < 50
    || hundredths > 150
    || hundredths % 5 !== 0) return null;
  return hundredths / 100;
}

function hasEvidence(
  evidence: string,
  latestMessage: string,
  normalized: string | number,
  pendingValue: string | number | null
): boolean {
  return latestMessage.includes(evidence)
    || (pendingValue !== null && normalized === pendingValue);
}

function schemaFeedback(error: z.ZodError): AssistantModelRepairFeedback {
  return error.issues.some((issue) => (
    issue.code === 'unrecognized_keys'
    || (issue.code === 'invalid_type' && issue.path.includes('evidence'))
  ))
    ? 'unsupported_parameter'
    : 'invalid_json_or_schema';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasUnsupportedShape(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'command') {
    if (!hasOnlyKeys(value, ['kind', 'intent', 'evidence'])
      || !isPlainRecord(value.evidence)) return true;
    const allowedEvidence = value.intent === 'move_training_day'
      ? ['sourceDateText', 'targetDateText']
      : value.intent === 'replace_meal'
        ? ['businessDateText', 'mealSlotText', 'dishNameText']
        : value.intent === 'resize_meal_portion'
          ? ['businessDateText', 'mealSlotText', 'multiplierText']
          : null;
    if (allowedEvidence === null
      || !hasOnlyKeys(value.evidence, allowedEvidence)) return true;
    return Object.values(value.evidence).some((field) => typeof field !== 'string');
  }
  if (value.kind === 'clarify') {
    return !hasOnlyKeys(value, ['kind', 'intent', 'missingFields']);
  }
  if (value.kind === 'reject') {
    return !hasOnlyKeys(value, ['kind', 'reason']);
  }
  return false;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function explicitDates(message: string): string[] {
  return unique(Array.from(message.matchAll(/\d{4}-\d{2}-\d{2}/g), (match) => match[0])
    .filter((value) => parseIsoDate(value) !== null));
}

function explicitSlots(message: string): MealSlot[] {
  return unique(Object.entries(slotAliases)
    .filter(([alias]) => message.includes(alias))
    .map(([, slot]) => slot));
}

function explicitMultipliers(message: string): number[] {
  const candidates = Array.from(
    message.matchAll(/\d+(?:\.\d+)?\s*倍|\d+(?:\.\d+)?%/g),
    (match) => parseMultiplier(match[0])
  );
  return unique(candidates.filter((value): value is number => value !== null));
}

function pendingForClarification(
  decision: Extract<RawAssistantDecision, { readonly kind: 'clarify' }>,
  context: AssistantEvidenceContext
): AssistantPendingClarification {
  const previous = context.pendingClarification?.intent === decision.intent
    ? context.pendingClarification
    : null;
  const dates = explicitDates(context.latestMessage);
  const slots = explicitSlots(context.latestMessage);
  if (decision.intent === 'move_training_day') {
    const prior = previous?.intent === decision.intent ? previous : null;
    const sourceDate = prior?.sourceDate
      ?? (!decision.missingFields.includes('source_date') && dates.length === 1 ? dates[0] ?? null : null);
    const targetDate = prior?.targetDate
      ?? (!decision.missingFields.includes('target_date') && dates.length === 1 ? dates[0] ?? null : null);
    return {
      intent: decision.intent,
      sourceDate,
      targetDate,
      missingFields: unique(decision.missingFields)
    };
  }
  if (decision.intent === 'replace_meal') {
    const prior = previous?.intent === decision.intent ? previous : null;
    return {
      intent: decision.intent,
      businessDate: prior?.businessDate
        ?? (!decision.missingFields.includes('business_date') && dates.length === 1 ? dates[0] ?? null : null),
      slot: prior?.slot
        ?? (!decision.missingFields.includes('meal_slot') && slots.length === 1 ? slots[0] ?? null : null),
      dishNameZh: prior?.dishNameZh ?? null,
      missingFields: unique(decision.missingFields)
    };
  }
  const prior = previous?.intent === decision.intent ? previous : null;
  const multipliers = explicitMultipliers(context.latestMessage);
  return {
    intent: decision.intent,
    businessDate: prior?.businessDate
      ?? (!decision.missingFields.includes('business_date') && dates.length === 1 ? dates[0] ?? null : null),
    slot: prior?.slot
      ?? (!decision.missingFields.includes('meal_slot') && slots.length === 1 ? slots[0] ?? null : null),
    multiplier: prior?.multiplier
      ?? (!decision.missingFields.includes('multiplier') && multipliers.length === 1
        ? multipliers[0] ?? null
        : null),
    missingFields: unique(decision.missingFields)
  };
}

function validateCommand(
  decision: Extract<RawAssistantDecision, { readonly kind: 'command' }>,
  context: AssistantEvidenceContext
): AssistantModelValidation {
  const pending = context.pendingClarification?.intent === decision.intent
    ? context.pendingClarification
    : null;
  if (decision.intent === 'move_training_day') {
    const sourceDate = parseIsoDate(decision.evidence.sourceDateText);
    const targetDate = parseIsoDate(decision.evidence.targetDateText);
    if (sourceDate === null || targetDate === null) {
      return { kind: 'invalid', feedback: 'unsupported_parameter' };
    }
    const matchingPending = pending?.intent === decision.intent ? pending : null;
    if (!hasEvidence(decision.evidence.sourceDateText, context.latestMessage, sourceDate, matchingPending?.sourceDate ?? null)
      || !hasEvidence(decision.evidence.targetDateText, context.latestMessage, targetDate, matchingPending?.targetDate ?? null)) {
      return { kind: 'invalid', feedback: 'evidence_not_explicit' };
    }
    return { kind: 'command', command: { kind: decision.intent, sourceDate, targetDate } };
  }
  const businessDate = parseIsoDate(decision.evidence.businessDateText);
  const slot = slotAliases[decision.evidence.mealSlotText] ?? null;
  if (businessDate === null || slot === null) {
    return { kind: 'invalid', feedback: 'unsupported_parameter' };
  }
  if (decision.intent === 'replace_meal') {
    const matchingPending = pending?.intent === decision.intent ? pending : null;
    if (!hasEvidence(decision.evidence.businessDateText, context.latestMessage, businessDate, matchingPending?.businessDate ?? null)
      || !hasEvidence(decision.evidence.mealSlotText, context.latestMessage, slot, matchingPending?.slot ?? null)
      || !hasEvidence(decision.evidence.dishNameText, context.latestMessage, decision.evidence.dishNameText, matchingPending?.dishNameZh ?? null)) {
      return { kind: 'invalid', feedback: 'evidence_not_explicit' };
    }
    return {
      kind: 'command',
      command: {
        kind: decision.intent,
        businessDate,
        slot,
        dishNameZh: decision.evidence.dishNameText
      }
    };
  }
  const multiplier = parseMultiplier(decision.evidence.multiplierText);
  if (multiplier === null) {
    return { kind: 'invalid', feedback: 'unsupported_parameter' };
  }
  const matchingPending = pending?.intent === decision.intent ? pending : null;
  if (!hasEvidence(decision.evidence.businessDateText, context.latestMessage, businessDate, matchingPending?.businessDate ?? null)
    || !hasEvidence(decision.evidence.mealSlotText, context.latestMessage, slot, matchingPending?.slot ?? null)
    || !hasEvidence(decision.evidence.multiplierText, context.latestMessage, multiplier, matchingPending?.multiplier ?? null)) {
    return { kind: 'invalid', feedback: 'evidence_not_explicit' };
  }
  return {
    kind: 'command',
    command: { kind: decision.intent, businessDate, slot, multiplier }
  };
}

export function validateAssistantModelOutput(
  rawText: string,
  context: AssistantEvidenceContext
): AssistantModelValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { kind: 'invalid', feedback: 'invalid_json_or_schema' };
  }
  const parsed = rawAssistantDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      feedback: hasUnsupportedShape(raw)
        ? 'unsupported_parameter'
        : schemaFeedback(parsed.error)
    };
  }
  if (parsed.data.kind === 'command') return validateCommand(parsed.data, context);
  if (parsed.data.kind === 'reject') {
    return { kind: 'reject', reason: parsed.data.reason };
  }
  return {
    kind: 'clarify',
    missingFields: unique(parsed.data.missingFields),
    pendingClarification: pendingForClarification(parsed.data, context)
  };
}
