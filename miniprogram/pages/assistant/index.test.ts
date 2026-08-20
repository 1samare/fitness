import { readFile } from 'node:fs/promises';
import {
  assistantApiResponseSchema,
  type AssistantApiRequest,
  type AssistantApiResponse,
  type PlanningApiRequest
} from '@fitness/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TextEvent { readonly detail: { readonly value: string } }
interface PageOptions {
  readonly data: Record<string, unknown>;
  onLoad(): Promise<void>;
  onMessageInput(event: TextEvent): void;
  onSend(): Promise<void>;
  onRetry(): Promise<void>;
  onOpenTrainingPlan(): void;
  onOpenMealPlan(): void;
}
interface PageInstance extends PageOptions {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
}

const assistantCalls: AssistantApiRequest[] = [];
const assistantResponses: (
  AssistantApiResponse | Promise<AssistantApiResponse>
)[] = [];
const planningCalls: PlanningApiRequest[] = [];
const storage = new Map<string, unknown>();
const navigations: string[] = [];
let registeredPage: PageOptions | undefined;

vi.mock('../../services/assistant-api', () => ({
  assistantApiClient: {
    call(request: AssistantApiRequest) {
      assistantCalls.push(request);
      const response = assistantResponses.shift();
      if (response === undefined) return Promise.reject(new Error('Missing assistant response'));
      return Promise.resolve(response).then((value) => assistantApiResponseSchema.parse(value));
    }
  }
}));

vi.mock('../../services/planning-api', () => ({
  planningApiClient: {
    call(request: PlanningApiRequest) {
      planningCalls.push(request);
      return Promise.resolve({ success: false, error: {
        code: 'internal_error', message: '仅用于验证刷新调用'
      } });
    }
  }
}));

function conversation(
  version: number,
  pendingTurn: { readonly expectedVersion: number; readonly idempotencyKey: string; readonly message: string } | null = null
): AssistantApiResponse {
  return {
    success: true,
    data: {
      kind: 'assistant_conversation', conversationVersion: version,
      messages: [], pendingTurn,
      supportedCommands: ['move_training_day', 'replace_meal', 'resize_meal_portion']
    }
  };
}

function completed(
  version: number,
  recoveryAction: 'none' | 'retry' | 'open_training_plan' | 'open_meal_plan' | 'review_meal_plan_changes' = 'none'
): AssistantApiResponse {
  return {
    success: true,
    data: {
      kind: 'assistant_turn_completed', conversationVersion: version,
      result: {
        kind: 'command_executed', command: 'move_training_day',
        message: '训练已移动，后续目标已按规则重算。', recoveryAction
      }
    }
  };
}

function pageInstance(): PageInstance {
  if (registeredPage === undefined) throw new Error('Page was not registered');
  return {
    ...registeredPage,
    data: { ...registeredPage.data },
    setData(patch) { Object.assign(this.data, patch); }
  };
}

beforeEach(async () => {
  assistantCalls.length = 0;
  assistantResponses.length = 0;
  planningCalls.length = 0;
  storage.clear();
  navigations.length = 0;
  registeredPage = undefined;
  vi.resetModules();
  vi.stubGlobal('Page', (options: PageOptions) => { registeredPage = options; });
  vi.stubGlobal('wx', {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => { storage.set(key, value); },
    removeStorageSync: (key: string) => { storage.delete(key); },
    navigateTo: ({ url }: { readonly url: string }) => { navigations.push(url); }
  });
  await import('./index');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('assistant page controller', () => {
  it('recovers a server pending turn only with the exact persisted envelope', async () => {
    const pending = {
      expectedVersion: 3,
      idempotencyKey: 'assistant-message-recovery-001',
      message: '把 2026-08-21 的训练移到 2026-08-22'
    };
    storage.set('fitness.pendingAssistantCommand.v1', pending);
    assistantResponses.push(conversation(3, pending), completed(4), conversation(4));
    const page = pageInstance();

    await page.onLoad.call(page);

    expect(assistantCalls).toEqual([
      { action: 'getAssistantConversation' },
      { action: 'sendAssistantMessage', payload: pending },
      { action: 'getAssistantConversation' }
    ]);
    expect(storage.has('fitness.pendingAssistantCommand.v1')).toBe(false);
    expect(planningCalls).toEqual([{ action: 'getCurrentContext' }]);
    expect(page.data.sending).toBe(false);
  });

  it('does not replay a mismatched local pending envelope', async () => {
    storage.set('fitness.pendingAssistantCommand.v1', {
      expectedVersion: 2,
      idempotencyKey: 'assistant-message-local-001',
      message: '本地不同消息'
    });
    assistantResponses.push(conversation(3, {
      expectedVersion: 3,
      idempotencyKey: 'assistant-message-server-001',
      message: '服务端原消息'
    }));
    const page = pageInstance();

    await page.onLoad.call(page);

    expect(assistantCalls).toEqual([{ action: 'getAssistantConversation' }]);
    expect(page.data.errorMessage).toContain('恢复记录不一致');
  });

  it('caps input at 2000 characters and prevents duplicate sends', async () => {
    let resolveTurn: ((value: AssistantApiResponse) => void) | undefined;
    const turn = new Promise<AssistantApiResponse>((resolve) => { resolveTurn = resolve; });
    assistantResponses.push(turn, conversation(1));
    const page = pageInstance();
    page.onMessageInput.call(page, { detail: { value: '字'.repeat(2100) } });

    const first = page.onSend.call(page);
    const duplicate = page.onSend.call(page);

    expect(String(page.data.messageInput)).toHaveLength(2000);
    expect(assistantCalls).toHaveLength(1);
    expect(page.data.sending).toBe(true);
    resolveTurn?.(completed(1));
    await Promise.all([first, duplicate]);
    expect(assistantCalls).toHaveLength(2);
  });

  it('refreshes conversation and planning context after a successful command', async () => {
    assistantResponses.push(completed(1, 'review_meal_plan_changes'), conversation(1));
    const page = pageInstance();
    page.onMessageInput.call(page, {
      detail: { value: '把 2026-08-21 的训练移到 2026-08-22' }
    });

    await page.onSend.call(page);

    expect(assistantCalls.map((request) => request.action)).toEqual([
      'sendAssistantMessage', 'getAssistantConversation'
    ]);
    expect(planningCalls).toEqual([{ action: 'getCurrentContext' }]);
    expect(page.data.statusMessage).toContain('训练已移动');
    expect(page.data.showMealPlanRecovery).toBe(true);
  });

  it('navigates only to the fixed structured recovery pages', () => {
    const page = pageInstance();

    page.onOpenTrainingPlan.call(page);
    page.onOpenMealPlan.call(page);

    expect(navigations).toEqual([
      '/pages/planning-setup/index', '/pages/meal-execution/index'
    ]);
  });

  it('registers fixed copy, plain-text rendering, and discoverable entry points', async () => {
    const [wxml, appJson, planningWxml, mealWxml] = await Promise.all([
      readFile(new URL('./index.wxml', import.meta.url), 'utf8'),
      readFile(new URL('../../app.json', import.meta.url), 'utf8'),
      readFile(new URL('../planning-setup/index.wxml', import.meta.url), 'utf8'),
      readFile(new URL('../meal-execution/index.wxml', import.meta.url), 'utf8')
    ]);

    expect(wxml).toContain('受限计划助手');
    expect(wxml).toContain('日期使用 YYYY-MM-DD');
    expect(wxml).toContain('0.5–1.5 倍');
    expect(wxml).toContain('maxlength="2000"');
    expect(wxml).toContain('disabled="{{sending || loadingConversation}}"');
    expect(wxml).not.toMatch(/<rich-text|bindtap="onExample|provider|model|toolChoice|工具选择/);
    const appConfig: unknown = JSON.parse(appJson);
    const pages = typeof appConfig === 'object'
      && appConfig !== null
      && 'pages' in appConfig
      && Array.isArray(appConfig.pages)
      ? appConfig.pages as unknown[]
      : [];
    expect(pages).toContain('pages/assistant/index');
    expect(planningWxml).toContain('bindtap="onOpenAssistant"');
    expect(mealWxml).toContain('bindtap="onOpenAssistant"');
  });
});
