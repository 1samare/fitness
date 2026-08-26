import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';

export interface IngredientPhotoCandidateView {
  readonly id: string;
  readonly name: string;
  readonly confidence: number;
  readonly state: string;
}

export interface IngredientPhotoPageSnapshot {
  readonly status: 'idle' | 'ready' | 'recognizing' | 'candidates' | 'confirmed' | 'manual_fallback';
  readonly previewUrl?: string;
  readonly candidates: readonly IngredientPhotoCandidateView[];
  readonly notice?: string;
}

export interface IngredientPhotoPageRuntime {
  selectImage(file: File): Promise<IngredientPhotoPageSnapshot>;
  recognize(): Promise<IngredientPhotoPageSnapshot>;
  confirm(candidateId: string, grams: number): Promise<IngredientPhotoPageSnapshot>;
  cancel(): Promise<IngredientPhotoPageSnapshot>;
}

const MANUAL_FALLBACK: IngredientPhotoPageSnapshot = {
  status: 'manual_fallback',
  candidates: [],
  notice: '图片识别当前不可用，请改用手动库存录入。'
};

export function IngredientPhotoPage({
  runtime
}: {
  readonly runtime?: IngredientPhotoPageRuntime | undefined;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<IngredientPhotoPageSnapshot>(
    runtime === undefined ? MANUAL_FALLBACK : { status: 'idle', candidates: [] }
  );
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [grams, setGrams] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function selectImage(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined || runtime === undefined) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await runtime.selectImage(file));
      setSelectedCandidateId('');
      setGrams('');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : '图片无法读取。');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function recognize(): Promise<void> {
    if (runtime === undefined) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await runtime.recognize());
    } catch {
      setSnapshot(MANUAL_FALLBACK);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (runtime === undefined) return;
    const parsedGrams = Number(grams);
    if (selectedCandidateId === '' || !Number.isSafeInteger(parsedGrams) || parsedGrams <= 0) {
      setError('请选择候选，并填写大于 0 的整数克数。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await runtime.confirm(selectedCandidateId, parsedGrams));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : '候选确认失败。');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (runtime === undefined) return;
    setSnapshot(await runtime.cancel());
    setSelectedCandidateId('');
    setGrams('');
  }

  return (
    <section className="panel ingredient-photo-page">
      <p className="eyebrow">MEMORY ONLY · EXPLICIT CONFIRMATION</p>
      <h2>食材图片候选识别</h2>
      <p className="notice">测试构建会把你选择的图片直接发送给已配置的第三方模型。请仅使用不含人脸、位置或其他敏感信息的内部测试图片；图片不会写入 IndexedDB 或备份。</p>

      {runtime !== undefined && (
        <label className="photo-picker">
          <span>选择 JPEG 或 PNG 图片</span>
          <input
            type="file"
            accept="image/jpeg,image/png"
            disabled={busy}
            onChange={(event) => { void selectImage(event); }}
          />
        </label>
      )}

      {snapshot.previewUrl !== undefined && (
        <img className="ingredient-preview" src={snapshot.previewUrl} alt="待识别食材预览" />
      )}

      {snapshot.status === 'ready' && (
        <button type="button" disabled={busy} onClick={() => { void recognize(); }}>
          发送图片并获取候选
        </button>
      )}

      {snapshot.candidates.length > 0 && (
        <fieldset className="candidate-list">
          <legend>最多五个白名单候选</legend>
          {snapshot.candidates.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="radio"
                name="ingredient-candidate"
                aria-label={`选择${candidate.name}`}
                checked={selectedCandidateId === candidate.id}
                onChange={() => setSelectedCandidateId(candidate.id)}
              />
              <strong>{candidate.name}</strong>
              <span>{candidate.state} · 置信度 {Math.round(candidate.confidence * 100)}%</span>
            </label>
          ))}
          <label htmlFor="confirmed-grams">确认克数</label>
          <input
            id="confirmed-grams"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={grams}
            onChange={(event) => setGrams(event.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => { void confirm(); }}>
            确认候选并写入库存
          </button>
        </fieldset>
      )}

      {snapshot.notice !== undefined && <p className="notice" role="status">{snapshot.notice}</p>}
      {error !== null && <p className="notice notice-error" role="alert">{error}</p>}

      {(snapshot.previewUrl !== undefined || snapshot.candidates.length > 0) && (
        <button type="button" className="button-secondary" disabled={busy} onClick={() => { void cancel(); }}>
          取消并释放图片
        </button>
      )}

      {snapshot.status === 'manual_fallback' && <Link to="/meals">前往手动录入</Link>}
    </section>
  );
}
