import { describe, expect, it, vi } from 'vitest';
import type { AssistantApiRequest } from '@fitness/contracts';
import {
  ASSISTANT_API_TIMEOUT_MS,
  createAssistantApiClient,
  createCloudAssistantTransport,
  createLocalAssistantTransport
} from './assistant-api';

const conversationResponse = {
  success: true,
  data: {
    kind: 'assistant_conversation',
    conversationVersion: 0,
    messages: [],
    pendingTurn: null,
    supportedCommands: [
      'move_training_day', 'replace_meal', 'resize_meal_portion'
    ]
  }
} as const;

describe('mini program assistant API client', () => {
  it('strictly validates responses before returning them', async () => {
    const client = createAssistantApiClient(() => Promise.resolve(conversationResponse));

    await expect(client.call({ action: 'getAssistantConversation' }))
      .resolves.toEqual(conversationResponse);

    const invalid = createAssistantApiClient(() => Promise.resolve({
      ...conversationResponse,
      model: 'must-not-reach-the-page'
    }));
    await expect(invalid.call({ action: 'getAssistantConversation' }))
      .rejects.toThrow('助手服务返回了无法识别的数据');
  });

  it('routes cloud requests only through the assistant-api function', async () => {
    const calls: { readonly name: string; readonly data: unknown }[] = [];
    const transport = createCloudAssistantTransport((name, data) => {
      calls.push({ name, data });
      return Promise.resolve(conversationResponse);
    });
    const request: AssistantApiRequest = { action: 'getAssistantConversation' };

    await transport(request);

    expect(calls).toEqual([{ name: 'assistant-api', data: request }]);
  });

  it('routes local requests to the isolated port 3001', async () => {
    const calls: { readonly url: string; readonly data: unknown; readonly timeout: number }[] = [];
    const transport = createLocalAssistantTransport((url, data, timeout) => {
      calls.push({ url, data, timeout });
      return Promise.resolve(conversationResponse);
    });

    await transport({ action: 'getAssistantConversation' });

    expect(calls).toEqual([{
      url: 'http://127.0.0.1:3001/',
      data: { action: 'getAssistantConversation' },
      timeout: ASSISTANT_API_TIMEOUT_MS
    }]);
  });

  it('rejects runtime request fields outside the public request contract', async () => {
    const transport = vi.fn(() => Promise.resolve(conversationResponse));
    const client = createAssistantApiClient(transport);

    await expect(client.call({
      action: 'getAssistantConversation',
      userId: 'attacker', provider: 'deepseek', model: 'hidden', tools: ['arbitrary']
    } as unknown as AssistantApiRequest)).rejects.toThrow('助手请求包含不受支持的字段');
    expect(transport).not.toHaveBeenCalled();
  });
});
