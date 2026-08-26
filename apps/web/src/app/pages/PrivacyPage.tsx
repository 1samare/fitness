import { usePlanning } from '../../features/planning/PlanningProvider';

export function PrivacyPage(): JSX.Element {
  const planning = usePlanning();
  return (
    <section className="panel prose-panel">
      <p className="eyebrow">PRIVACY & SCOPE</p>
      <h2>隐私与内部测试边界</h2>
      <div className="boundary-grid">
        <article><strong>只用虚拟数据</strong><p>不要填写本人或他人的真实身体、健康、照片与身份信息。</p></article>
        <article><strong>只保存在此浏览器</strong><p>规划数据保存在本机 IndexedDB；清除站点数据会删除记录。</p></article>
        <article><strong>不是医疗建议</strong><p>仅支持健康成年人测试。疾病、孕期、未成年人、康复和极端目标停止建议。</p></article>
        <article><strong>所有数值均为估算</strong><p>热量、训练消耗与营养目标由版本化确定性策略计算，不表示精准测量。</p></article>
      </div>
      <button
        className="primary-button"
        type="button"
        disabled={planning.busy || planning.snapshot.setupConfirmed}
        onClick={() => { planning.confirmTestBoundary().catch(() => undefined); }}
      >
        {planning.snapshot.setupConfirmed ? '内部测试边界已确认' : '确认边界并继续'}
      </button>
    </section>
  );
}
