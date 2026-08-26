import type { AssistantLanguageModelInput } from '@fitness/agent';
import {
  LanguageModelBackendError,
  type AssistantLanguageModelBackend,
  type AssistantLanguageModelBackendResult,
  type LanguageModelBackendFailureReason,
  type LanguageModelProviderErrorCode
} from '@fitness/providers/browser';
import { z } from 'zod';

const usageSchema = z.object({
  total_tokens: z.number().int().nonnegative().optional()
}).loose();

const responseSchema = z.object({
  id: z.string().trim().min(1).max(256).optional(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().trim().min(1)
    }).loose()
  }).loose()).min(1).max(8),
  usage: usageSchema.optional()
}).loose();

export class BrowserLanguageModelError extends LanguageModelBackendError {
  public constructor(
    code: LanguageModelProviderErrorCode,
    reason: LanguageModelBackendFailureReason,
    transient: boolean
  ) {
    super(reason, transient, code);
    this.name = 'BrowserLanguageModelError';
  }
}

export interface OpenAICompatibleBrowserBackendOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function requestUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new TypeError('Browser language model base URL must use HTTPS');
  }
  return `${normalized}/chat/completions`;
}

function httpFailure(status: number): BrowserLanguageModelError {
  if (status === 401 || status === 403) {
    return new BrowserLanguageModelError('provider_auth_failed', 'auth_failed', false);
  }
  if (status === 429) {
    return new BrowserLanguageModelError('provider_rate_limited', 'rate_limited', true);
  }
  return new BrowserLanguageModelError('provider_unavailable', 'supplier_error', status >= 500);
}

export class OpenAICompatibleBrowserBackend implements AssistantLanguageModelBackend {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: OpenAICompatibleBrowserBackendOptions) {
    this.url = requestUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (options.apiKey.trim() === '' || options.model.trim() === '') {
      throw new TypeError('Browser language model configuration is incomplete');
    }
  }

  public async generate(
    input: AssistantLanguageModelInput
  ): Promise<AssistantLanguageModelBackendResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.systemPrompt },
            ...(input.repairPrompt === undefined
              ? []
              : [{ role: 'system' as const, content: input.repairPrompt }]),
            ...input.messages
          ]
        }),
        signal: controller.signal
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new BrowserLanguageModelError('provider_unavailable', 'timeout', true);
      }
      if (error instanceof TypeError) {
        throw new BrowserLanguageModelError(
          'provider_cors_unavailable',
          'cors_unavailable',
          false
        );
      }
      throw new BrowserLanguageModelError(
        'provider_unavailable',
        'transport_unavailable',
        true
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw httpFailure(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BrowserLanguageModelError('provider_unavailable', 'invalid_response', false);
    }
    const parsed = responseSchema.safeParse(payload);
    const first = parsed.success ? parsed.data.choices[0] : undefined;
    if (!parsed.success || first === undefined) {
      throw new BrowserLanguageModelError('provider_unavailable', 'invalid_response', false);
    }
    return {
      rawText: first.message.content,
      ...(parsed.data.id === undefined ? {} : { requestId: parsed.data.id }),
      ...(parsed.data.usage?.total_tokens === undefined
        ? {}
        : { estimatedCostUnits: parsed.data.usage.total_tokens })
    };
  }
}
