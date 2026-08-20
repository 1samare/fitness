import type { AssistantLanguageModelInput } from '@fitness/agent';
import { z } from 'zod';

export type LanguageModelBackendFailureReason =
  | 'transport_unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'supplier_error'
  | 'circuit_open';

export class LanguageModelBackendError extends Error {
  public readonly code = 'provider_unavailable' as const;

  public constructor(
    public readonly reason: LanguageModelBackendFailureReason,
    public readonly transient: boolean
  ) {
    super('Language model Provider is unavailable');
    this.name = 'LanguageModelBackendError';
  }
}

export interface CloudBaseTextModel {
  readonly generateText: (input: {
    readonly model: string;
    readonly messages: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
  }) => Promise<unknown>;
}

export interface AssistantLanguageModelBackendResult {
  readonly rawText: string;
  readonly requestId?: string;
  readonly estimatedCostUnits?: number;
}

export interface AssistantLanguageModelBackend {
  generate(input: AssistantLanguageModelInput): Promise<AssistantLanguageModelBackendResult>;
}

const snakeUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional()
}).strict();

const camelUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
}).strict();

const responseEnvelopeSchema = z.object({
  text: z.string().trim().min(1),
  usage: z.union([snakeUsageSchema, camelUsageSchema]).optional(),
  messages: z.array(z.unknown()).max(30).optional(),
  rawResponses: z.array(z.unknown()).max(20).optional(),
  error: z.unknown().optional()
}).strict();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const transientTransportCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

function isAllowlistedTransientTransportError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error.code;
  return typeof code === 'string' && transientTransportCodes.has(code.toUpperCase());
}

function safeRequestId(rawResponses: readonly unknown[] | undefined): string | undefined {
  for (const response of rawResponses ?? []) {
    if (!isRecord(response)) continue;
    for (const key of ['request_id', 'requestId', 'id'] as const) {
      const value = response[key];
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) {
        return value;
      }
    }
  }
  return undefined;
}

function estimatedCostUnits(
  usage: z.infer<typeof responseEnvelopeSchema>['usage']
): number | undefined {
  if (usage === undefined) return undefined;
  if ('total_tokens' in usage && usage.total_tokens !== undefined) return usage.total_tokens;
  if ('totalTokens' in usage && usage.totalTokens !== undefined) return usage.totalTokens;
  if ('input_tokens' in usage
    || 'prompt_tokens' in usage
    || 'output_tokens' in usage
    || 'completion_tokens' in usage) {
    return (usage.input_tokens ?? usage.prompt_tokens ?? 0)
      + (usage.output_tokens ?? usage.completion_tokens ?? 0);
  }
  if ('promptTokens' in usage || 'completionTokens' in usage) {
    return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }
  return undefined;
}

export interface CloudBaseLanguageModelBackendOptions {
  readonly providerId: string;
  readonly modelName: string;
  readonly model: CloudBaseTextModel;
}

export class CloudBaseLanguageModelBackend implements AssistantLanguageModelBackend {
  public readonly providerId: string;

  public constructor(private readonly options: CloudBaseLanguageModelBackendOptions) {
    this.providerId = options.providerId;
  }

  public async generate(
    input: AssistantLanguageModelInput
  ): Promise<AssistantLanguageModelBackendResult> {
    let response: unknown;
    try {
      response = await this.options.model.generateText({
        model: this.options.modelName,
        messages: [
          { role: 'system', content: input.systemPrompt },
          ...(input.repairPrompt === undefined
            ? []
            : [{ role: 'system' as const, content: input.repairPrompt }]),
          ...input.messages
        ]
      });
    } catch (error: unknown) {
      if (error instanceof LanguageModelBackendError) throw error;
      throw isAllowlistedTransientTransportError(error)
        ? new LanguageModelBackendError('transport_unavailable', true)
        : new LanguageModelBackendError('supplier_error', false);
    }
    const parsed = responseEnvelopeSchema.safeParse(response);
    if (!parsed.success) {
      throw new LanguageModelBackendError('invalid_response', false);
    }
    if (parsed.data.error !== undefined && parsed.data.error !== null) {
      throw new LanguageModelBackendError('supplier_error', false);
    }
    const requestId = safeRequestId(parsed.data.rawResponses);
    const costUnits = estimatedCostUnits(parsed.data.usage);
    return {
      rawText: parsed.data.text,
      ...(requestId === undefined ? {} : { requestId }),
      ...(costUnits === undefined ? {} : { estimatedCostUnits: costUnits })
    };
  }
}
