import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DataPage,
  type DataPageRuntime
} from '../../app/pages/DataPage';

afterEach(() => cleanup());

function runtime(): DataPageRuntime {
  return {
    exportBackup: vi.fn(() => Promise.resolve()),
    restoreBackup: vi.fn(() => Promise.resolve()),
    deleteAccount: vi.fn(() => Promise.resolve())
  };
}

describe('DataPage', () => {
  test('exports a complete local backup', async () => {
    const target = runtime();
    render(<DataPage runtime={target} />);

    fireEvent.click(screen.getByRole('button', { name: '下载完整本地备份' }));

    await waitFor(() => expect(target.exportBackup).toHaveBeenCalledOnce());
    expect(await screen.findByText('完整本地备份已生成。')).toBeTruthy();
  });

  test('requires an explicit overwrite confirmation before restore', async () => {
    const target = runtime();
    render(<DataPage runtime={target} />);
    const file = new File(['{"format":"fitness-local-backup-v1"}'], 'backup.json', {
      type: 'application/json'
    });

    fireEvent.change(screen.getByLabelText('选择本地备份文件'), {
      target: { files: [file] }
    });
    expect(screen.getByRole('button', { name: '覆盖并恢复' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('确认覆盖当前本地数据'));
    fireEvent.click(screen.getByRole('button', { name: '覆盖并恢复' }));

    await waitFor(() => expect(target.restoreBackup).toHaveBeenCalledWith(file));
  });

  test('requires the exact deletion phrase and delegates atomic account deletion', async () => {
    const target = runtime();
    render(<DataPage runtime={target} />);

    fireEvent.change(screen.getByLabelText('删除确认短语'), {
      target: { value: 'DELETE LOCAL DATA' }
    });
    fireEvent.click(screen.getByRole('button', { name: '永久删除本地账户' }));

    await waitFor(() => expect(target.deleteAccount).toHaveBeenCalledOnce());
  });

  test('keeps the page usable and renders a safe error when an operation fails', async () => {
    const target = runtime();
    vi.mocked(target.exportBackup).mockRejectedValueOnce(new Error('backup_failed'));
    render(<DataPage runtime={target} />);

    fireEvent.click(screen.getByRole('button', { name: '下载完整本地备份' }));

    expect((await screen.findByRole('alert')).textContent).toContain('本地数据操作失败，请检查文件后重试。');
    expect(screen.getByRole('button', { name: '下载完整本地备份' }).hasAttribute('disabled')).toBe(false);
  });
});
