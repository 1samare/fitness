import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppRouteElements } from '../../app/routes';
import type {
  AssistantPageRuntime,
  AssistantPageSnapshot
} from '../../app/pages/AssistantPage';

afterEach(() => cleanup());

describe('local assistant Web experience', () => {
  test('sends a structured planning request and renders the validated reply', async () => {
    const initial: AssistantPageSnapshot = { messages: [], status: 'ready' };
    const completed: AssistantPageSnapshot = {
      status: 'ready',
      messages: [
        { id: 'user-1', role: 'user', text: '把周一训练移到周二' },
        { id: 'assistant-1', role: 'assistant', text: '训练已移动，受影响日期已重新计算。' }
      ]
    };
    const runtime: AssistantPageRuntime = {
      initialize: vi.fn(async () => initial),
      sendMessage: vi.fn(async () => completed)
    };

    render(
      <MemoryRouter initialEntries={['/assistant']}>
        <AppRouteElements assistantRuntime={runtime} />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: '有限对话修改计划' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('计划修改指令'), {
      target: { value: '把周一训练移到周二' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发送并校验' }));

    expect(await screen.findByText('训练已移动，受影响日期已重新计算。')).toBeTruthy();
    expect(runtime.sendMessage).toHaveBeenCalledWith('把周一训练移到周二');
  });

  test('keeps structured controls available when the model provider is unavailable', async () => {
    const runtime: AssistantPageRuntime = {
      initialize: vi.fn(async (): Promise<AssistantPageSnapshot> => ({ messages: [], status: 'ready' })),
      sendMessage: vi.fn(async (): Promise<AssistantPageSnapshot> => ({
        messages: [],
        status: 'degraded',
        notice: '模型暂时不可用，请使用结构化控件继续。'
      }))
    };

    render(
      <MemoryRouter initialEntries={['/assistant']}>
        <AppRouteElements assistantRuntime={runtime} />
      </MemoryRouter>
    );
    fireEvent.change(await screen.findByLabelText('计划修改指令'), {
      target: { value: '把午餐鸡胸肉换成豆腐' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发送并校验' }));

    expect(await screen.findByText('模型暂时不可用，请使用结构化控件继续。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开训练结构化控件' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开餐单结构化控件' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '发送并校验' }).hasAttribute('disabled')).toBe(false));
  });
});
