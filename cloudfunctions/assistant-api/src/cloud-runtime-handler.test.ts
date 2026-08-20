import type {
  CloudBaseDatabase,
  CloudBaseDocumentReference,
  CloudBaseTransaction
} from '@fitness/persistence';
import type { CloudBaseTextModel } from '@fitness/providers';
import { describe, expect, it, vi } from 'vitest';
import {
  AssistantRuntimeConfigurationError,
  createCloudRuntimeAssistantHandler
} from './cloud-runtime-handler';

class FakeDocumentReference implements CloudBaseDocumentReference {
  public constructor(
    private readonly documents: Map<string, unknown>,
    private readonly key: string
  ) {}
  public get(): Promise<{ readonly data?: unknown }> {
    const data = this.documents.get(this.key);
    return Promise.resolve(data === undefined ? {} : { data });
  }
  public set(input: { readonly data: unknown }): Promise<unknown> {
    this.documents.set(this.key, structuredClone(input.data));
    return Promise.resolve({ updated: 1 });
  }
}

class FakeDatabase implements CloudBaseDatabase, CloudBaseTransaction {
  private readonly documents = new Map<string, unknown>();
  public collection(name: string) {
    return {
      doc: (id: string) => new FakeDocumentReference(this.documents, `${name}/${id}`)
    };
  }
  public runTransaction<TResult>(
    operation: (transaction: CloudBaseTransaction) => Promise<TResult>
  ): Promise<TResult> {
    return operation(this);
  }
}

const commandOutput = JSON.stringify({
  kind: 'command',
  intent: 'move_training_day',
  evidence: {
    sourceDateText: '2026-08-24',
    targetDateText: '2026-08-25'
  }
});

function send(handler: ReturnType<typeof createCloudRuntimeAssistantHandler>, suffix: string) {
  return handler({
    action: 'sendAssistantMessage',
    payload: {
      expectedVersion: 0,
      idempotencyKey: `assistant-cloud-${suffix}`,
      message: '把 2026-08-24 的训练移到 2026-08-25'
    }
  }, { userId: `cloud-user-${suffix}` });
}

describe('cloud assistant runtime', () => {
  it.each([
    ['cloudbase', 'hunyuan-2.0-instruct-20251111'],
    ['cloudbase', 'deepseek-v4-flash'],
    ['custom-deepseek-production', 'deepseek-chat']
  ])('passes explicit Provider %s and model %s without fallback', async (providerId, modelName) => {
    const generateText = vi.fn(() => Promise.resolve({
      text: commandOutput,
      messages: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      rawResponses: [{ request_id: 'supplier-request-1' }]
    }));
    const model: CloudBaseTextModel = { generateText };
    const createModel = vi.fn((selectedProvider: string) => {
      void selectedProvider;
      return model;
    });
    const handler = createCloudRuntimeAssistantHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      environment: {
        CLOUDBASE_ENV_ID: 'environment-1',
        FITNESS_LLM_PROVIDER_ID: providerId,
        FITNESS_LLM_MODEL: modelName
      },
      createModel,
      now: () => '2026-08-20T00:00:00.000Z'
    });

    const response = await send(handler, modelName.replaceAll('.', '-'));
    expect(response).toMatchObject({
      success: true,
      data: { result: { kind: 'command_rejected' } }
    });
    expect(createModel).toHaveBeenCalledOnce();
    expect(createModel).toHaveBeenCalledWith(providerId);
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model: modelName }));
  });

  it.each([
    {},
    { CLOUDBASE_ENV_ID: 'environment-1' },
    { CLOUDBASE_ENV_ID: 'environment-1', FITNESS_LLM_PROVIDER_ID: 'cloudbase' }
  ])('fails closed when any explicit LLM environment value is absent', (environment) => {
    const createModel = vi.fn();
    expect(() => createCloudRuntimeAssistantHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      environment,
      createModel
    })).toThrow(AssistantRuntimeConfigurationError);
    expect(createModel).not.toHaveBeenCalled();
  });

  it('does not create or call a second Provider after a model failure', async () => {
    const generateText = vi.fn(() => Promise.reject(new Error('supplier unavailable')));
    const createModel = vi.fn((): CloudBaseTextModel => ({ generateText }));
    const handler = createCloudRuntimeAssistantHandler({
      runtimeMode: 'cloud',
      database: new FakeDatabase(),
      environment: {
        CLOUDBASE_ENV_ID: 'environment-1',
        FITNESS_LLM_PROVIDER_ID: 'custom-deepseek-production',
        FITNESS_LLM_MODEL: 'deepseek-chat'
      },
      createModel,
      now: () => '2026-08-20T00:00:00.000Z'
    });

    await expect(send(handler, 'provider-failure')).resolves.toMatchObject({
      success: true,
      data: {
        result: { kind: 'assistant_unavailable', reason: 'provider_unavailable' }
      }
    });
    expect(createModel).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});
