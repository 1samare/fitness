import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

export interface AssistantPageMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface AssistantPageSnapshot {
  readonly messages: readonly AssistantPageMessage[];
  readonly status: 'ready' | 'degraded';
  readonly notice?: string;
}

export interface AssistantPageRuntime {
  initialize(): Promise<AssistantPageSnapshot>;
  sendMessage(message: string): Promise<AssistantPageSnapshot>;
}

const UNAVAILABLE_SNAPSHOT: AssistantPageSnapshot = {
  messages: [],
  status: 'degraded',
  notice: '模型暂时不可用，请使用结构化控件继续。'
};

export function AssistantPage({
  runtime
}: {
  readonly runtime?: AssistantPageRuntime | undefined;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<AssistantPageSnapshot>(UNAVAILABLE_SNAPSHOT);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(runtime !== undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (runtime === undefined) {
      setSnapshot(UNAVAILABLE_SNAPSHOT);
      setBusy(false);
      return () => { active = false; };
    }
    runtime.initialize()
      .then((next) => { if (active) setSnapshot(next); })
      .catch(() => { if (active) setSnapshot(UNAVAILABLE_SNAPSHOT); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [runtime]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = message.trim();
    if (runtime === undefined) {
      setSnapshot(UNAVAILABLE_SNAPSHOT);
      return;
    }
    if (normalized.length < 1 || normalized.length > 2_000) {
      setError('指令长度必须为 1–2000 个字符。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await runtime.sendMessage(normalized));
      setMessage('');
    } catch {
      setSnapshot(UNAVAILABLE_SNAPSHOT);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel assistant-page">
      <p className="eyebrow">SINGLE AGENT · VALIDATED COMMANDS</p>
      <h2>有限对话修改计划</h2>
      <p>助手只能执行移动训练、替换餐食和调整份量三类白名单命令；所有数值仍由确定性代码计算。</p>

      {snapshot.messages.length > 0 && (
        <ol className="assistant-transcript" aria-label="对话记录">
          {snapshot.messages.map((item) => (
            <li key={item.id} className={`assistant-message assistant-message-${item.role}`}>
              <strong>{item.role === 'user' ? '你' : '助手'}</strong>
              <p>{item.text}</p>
            </li>
          ))}
        </ol>
      )}

      {snapshot.notice !== undefined && <p className="notice" role="status">{snapshot.notice}</p>}
      {error !== null && <p className="notice notice-error" role="alert">{error}</p>}

      <form className="assistant-composer" onSubmit={(event) => { void submit(event); }}>
        <label htmlFor="assistant-command">计划修改指令</label>
        <textarea
          id="assistant-command"
          rows={4}
          maxLength={2_000}
          value={message}
          disabled={busy || runtime === undefined}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="例如：把周一训练移到周二"
        />
        <button type="submit" disabled={busy || runtime === undefined}>
          {busy ? '正在校验…' : '发送并校验'}
        </button>
      </form>

      {snapshot.status === 'degraded' && (
        <div className="structured-fallback" aria-label="结构化降级入口">
          <Link to="/setup">打开训练结构化控件</Link>
          <Link to="/meals">打开餐单结构化控件</Link>
        </div>
      )}
    </section>
  );
}
