import { z } from 'zod';
import type {
  LocalVisionBackend,
  RawVisionCandidate
} from '../features/ingredient-photo/local-image-candidate-runtime';

const candidateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  confidence: z.number().min(0).max(1),
  foodState: z.enum(['raw', 'cooked', 'dry', 'unknown'])
}).strict();

const candidateEnvelopeSchema = z.object({
  candidates: z.array(candidateSchema).max(5)
}).strict();

const responseSchema = z.object({
  id: z.string().trim().min(1).max(256).optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) }).loose()
  }).loose()).min(1).max(8)
}).loose();

export type BrowserVisionFailureReason =
  | 'cors_unavailable'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_response'
  | 'provider_unavailable';

export class BrowserVisionBackendError extends Error {
  public readonly code = 'vision_unavailable' as const;

  public constructor(public readonly reason: BrowserVisionFailureReason) {
    super('Browser vision Provider is unavailable');
    this.name = 'BrowserVisionBackendError';
  }
}

export interface OpenAICompatibleBrowserVisionBackendOptions {
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
    throw new TypeError('Browser vision base URL must use HTTPS');
  }
  return `${normalized}/chat/completions`;
}

function statusReason(status: number): BrowserVisionFailureReason {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  return 'provider_unavailable';
}

export class OpenAICompatibleBrowserVisionBackend implements LocalVisionBackend {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(private readonly options: OpenAICompatibleBrowserVisionBackendOptions) {
    this.url = requestUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (options.apiKey.trim() === '' || options.model.trim() === '') {
      throw new TypeError('Browser vision configuration is incomplete');
    }
  }

  public async recognize(input: {
    readonly requestId: string;
    readonly dataUrl: string;
    readonly mediaType: 'image/jpeg' | 'image/png';
  }): Promise<{ readonly requestId?: string; readonly candidates: readonly RawVisionCandidate[] }> {
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
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: '识别图中的食材候选。只返回 candidates 数组，每项仅含 name、confidence、foodState；最多五项，禁止克数、营养值、用户信息和解释。'
              },
              { type: 'image_url', image_url: { url: input.dataUrl } }
            ]
          }]
        }),
        signal: controller.signal
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new BrowserVisionBackendError('timeout');
      if (error instanceof TypeError) throw new BrowserVisionBackendError('cors_unavailable');
      throw new BrowserVisionBackendError('provider_unavailable');
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new BrowserVisionBackendError(statusReason(response.status));

    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new BrowserVisionBackendError('invalid_response');
    }
    const envelope = responseSchema.safeParse(rawResponse);
    const first = envelope.success ? envelope.data.choices[0] : undefined;
    if (!envelope.success || first === undefined) {
      throw new BrowserVisionBackendError('invalid_response');
    }
    let rawCandidates: unknown;
    try {
      rawCandidates = JSON.parse(first.message.content);
    } catch {
      throw new BrowserVisionBackendError('invalid_response');
    }
    const candidates = candidateEnvelopeSchema.safeParse(rawCandidates);
    if (!candidates.success) throw new BrowserVisionBackendError('invalid_response');
    return {
      ...(envelope.data.id === undefined ? {} : { requestId: envelope.data.id }),
      candidates: candidates.data.candidates
    };
  }
}
