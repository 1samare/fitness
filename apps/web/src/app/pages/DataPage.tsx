import { useState, type ChangeEvent } from 'react';

export interface DataPageRuntime {
  exportBackup(): Promise<void>;
  restoreBackup(file: File): Promise<void>;
  deleteAccount(): Promise<void>;
}

const DELETE_PHRASE = 'DELETE LOCAL DATA';

export function DataPage({ runtime }: { readonly runtime: DataPageRuntime }): JSX.Element {
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function execute(action: () => Promise<void>, success: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(success);
    } catch {
      setError('本地数据操作失败，请检查文件后重试。');
    } finally {
      setBusy(false);
    }
  }

  function selectBackup(event: ChangeEvent<HTMLInputElement>): void {
    setBackupFile(event.target.files?.[0] ?? null);
    setOverwriteConfirmed(false);
    setNotice(null);
    setError(null);
  }

  return (
    <section className="panel data-page">
      <p className="eyebrow">LOCAL DATA RIGHTS</p>
      <h2>数据、备份与删除</h2>
      <p>数据只保存在当前浏览器 origin。完整备份包含虚拟规划、设置和测试数据集，不包含测试 API Key 或原始图片。</p>

      <section className="workflow-block">
        <h3>完整备份</h3>
        <p>下载 `fitness-local-backup-v1` JSON 文件，可在空库或明确覆盖后恢复。</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => { void execute(() => runtime.exportBackup(), '完整本地备份已生成。'); }}
        >
          下载完整本地备份
        </button>
      </section>

      <section className="workflow-block">
        <h3>原子恢复</h3>
        <label>
          选择本地备份文件
          <input type="file" accept="application/json,.json" disabled={busy} onChange={selectBackup} />
        </label>
        <label className="confirmation-row">
          <input
            type="checkbox"
            checked={overwriteConfirmed}
            disabled={busy || backupFile === null}
            onChange={(event) => setOverwriteConfirmed(event.target.checked)}
          />
          确认覆盖当前本地数据
        </label>
        <button
          type="button"
          disabled={busy || backupFile === null || !overwriteConfirmed}
          onClick={() => {
            if (backupFile !== null) {
              void execute(() => runtime.restoreBackup(backupFile), '备份已恢复，正在重新载入。');
            }
          }}
        >
          覆盖并恢复
        </button>
      </section>

      <section className="workflow-block danger-zone">
        <h3>永久删除本地账户</h3>
        <p>此操作删除规划、设置、测试数据集、页面草稿和助手恢复状态。请先下载备份。</p>
        <label htmlFor="delete-local-phrase">删除确认短语</label>
        <input
          id="delete-local-phrase"
          value={deletePhrase}
          disabled={busy}
          placeholder={DELETE_PHRASE}
          autoComplete="off"
          onChange={(event) => setDeletePhrase(event.target.value)}
        />
        <button
          type="button"
          className="danger-button"
          disabled={busy || deletePhrase !== DELETE_PHRASE}
          onClick={() => { void execute(() => runtime.deleteAccount(), '本地账户已删除，正在重新载入。'); }}
        >
          永久删除本地账户
        </button>
      </section>

      {notice !== null && <p role="status" className="notice">{notice}</p>}
      {error !== null && <p role="alert" className="notice notice-error">{error}</p>}
    </section>
  );
}
