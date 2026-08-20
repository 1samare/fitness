import { describe, expect, it, vi } from 'vitest';
import {
  CloudBaseLanguageModelBackend,
  LanguageModelBackendError,
  type CloudBaseTextModel
} from './cloudbase-language-model-backend';

const modelInput = {
  requestId: 'turn-0001-model-0',
  systemPrompt: 'fixed system policy',
  messages: [{
    role: 'user' as const,
    content: '把 2026-08-24 的训练移到 2026-08-25'
  }],
  repairAttempt: 0 as const
};

function modelReturning(response: unknown): CloudBaseTextModel & {
  generateText: ReturnType<typeof vi.fn>;
} {
  return {
    generateText: vi.fn(() => Promise.resolve(response))
  };
}

describe('CloudBaseLanguageModelBackend', () => {
  it.each([
    ['cloudbase', 'hunyuan-turbos-latest'],
    ['cloudbase', 'deepseek-v4-flash'],
    ['custom-deepseek', 'deepseek-chat']
  ])('maps fixed prompts for explicit Provider %s and model %s', async (providerId, modelName) => {
    const model = modelReturning({
      text: '{"kind":"reject","reason":"unsupported_request"}',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      messages: [{ role: 'assistant', content: 'not observed by the adapter' }],
      rawResponses: [{ request_id: 'supplier-request-1', ignored: 'not observed' }]
    });
    const backend = new CloudBaseLanguageModelBackend({ providerId, modelName, model });

    await expect(backend.generate(modelInput)).resolves.toEqual({
      rawText: '{"kind":"reject","reason":"unsupported_request"}',
      requestId: 'supplier-request-1',
      estimatedCostUnits: 15
    });
    expect(model.generateText).toHaveBeenCalledWith({
      model: modelName,
      messages: [
        { role: 'system', content: 'fixed system policy' },
        { role: 'user', content: '把 2026-08-24 的训练移到 2026-08-25' }
      ]
    });
    expect(backend.providerId).toBe(providerId);
  });

  it('adds only the fixed repair instruction and accepts camel-case usage', async () => {
    const model = modelReturning({
      text: '{}',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      rawResponses: [{ requestId: 'supplier-request-2' }]
    });
    const backend = new CloudBaseLanguageModelBackend({
      providerId: 'cloudbase',
      modelName: 'deepseek-v4-flash',
      model
    });
    await expect(backend.generate({
      ...modelInput,
      repairAttempt: 1,
      repairFeedback: 'invalid_json_or_schema',
      repairPrompt: 'fixed repair instruction'
    })).resolves.toMatchObject({ requestId: 'supplier-request-2', estimatedCostUnits: 5 });
    expect(model.generateText).toHaveBeenCalledWith({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'fixed system policy' },
        { role: 'system', content: 'fixed repair instruction' },
        { role: 'user', content: '把 2026-08-24 的训练移到 2026-08-25' }
      ]
    });
  });

  it.each([
    [{ text: '' }, 'invalid_response'],
    [{ text: '{}', unexpected: true }, 'invalid_response'],
    [{ text: '{}', usage: { total_tokens: -1 } }, 'invalid_response'],
    [{ text: '{}', error: { message: 'supplier secret' } }, 'supplier_error']
  ] as const)('rejects malformed or supplier-error envelope %#', async (response, reason) => {
    const model = modelReturning(response);
    const backend = new CloudBaseLanguageModelBackend({
      providerId: 'cloudbase',
      modelName: 'hunyuan-turbos-latest',
      model
    });
    await expect(backend.generate(modelInput)).rejects.toEqual(
      expect.objectContaining({ code: 'provider_unavailable', reason })
    );
  });

  it('extracts request IDs only from request_id, requestId, or id', async () => {
    const model = modelReturning({
      text: '{}',
      rawResponses: [{ trace_id: 'forbidden-trace', nested: { id: 'forbidden-nested' } }]
    });
    const backend = new CloudBaseLanguageModelBackend({
      providerId: 'cloudbase',
      modelName: 'hunyuan-turbos-latest',
      model
    });
    await expect(backend.generate(modelInput)).resolves.toEqual({ rawText: '{}' });
  });

  it('fails closed on an unclassified model rejection without retrying it as transport', async () => {
    const model: CloudBaseTextModel = {
      generateText: () => Promise.reject(new Error('API key=secret'))
    };
    const backend = new CloudBaseLanguageModelBackend({
      providerId: 'cloudbase',
      modelName: 'hunyuan-turbos-latest',
      model
    });
    const error = await backend.generate(modelInput).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LanguageModelBackendError);
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      reason: 'supplier_error',
      transient: false
    });
    expect(String(error)).not.toContain('API key=secret');
  });

  it.each([
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT'
  ])('classifies only the allowlisted transport code %s as transient', async (code) => {
    const supplierError = Object.assign(new Error('supplier secret'), { code });
    const model: CloudBaseTextModel = {
      generateText: () => Promise.reject(supplierError)
    };
    const backend = new CloudBaseLanguageModelBackend({
      providerId: 'cloudbase',
      modelName: 'deepseek-v4-flash',
      model
    });

    await expect(backend.generate(modelInput)).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'transport_unavailable',
      transient: true
    });
  });
});
