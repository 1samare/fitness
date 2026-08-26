import { Link } from 'react-router-dom';
import { detectBrowserCapabilities } from '../../features/capability-check/capability-check';
import { usePlanning } from '../../features/planning/PlanningProvider';

function renderCapabilityItems(missing: readonly string[]): JSX.Element {
  if (missing.length === 0) {
    return <p>浏览器能力检查通过，支持本地测试入口。</p>;
  }
  return (
    <ul className="capability-list">
      {missing.map((code) => (
        <li key={code}>{code}</li>
      ))}
    </ul>
  );
}

export function HomePage(): JSX.Element {
  const compatibility = detectBrowserCapabilities();
  const planning = usePlanning();
  const versions = planning.snapshot.context.latestVersions;

  return (
    <section className="panel home-panel">
      <div className="hero-copy">
        <p className="eyebrow">LOCAL-FIRST FITNESS LAB</p>
        <h2>把一周训练，翻译成可追溯的每日营养目标。</h2>
        <p className="section-lead">这是虚拟数据内部测试工作台。确定性策略负责数值，浏览器负责保管数据，你始终能看到版本和适用边界。</p>
        <div className="hero-actions">
          {planning.snapshot.setupConfirmed
            ? <Link className="primary-button link-button" to="/setup">开始结构化建档</Link>
            : <button className="primary-button" type="button" disabled={planning.busy} onClick={() => { planning.confirmTestBoundary().catch(() => undefined); }}>确认边界并继续</button>}
          <Link className="secondary-button" to="/privacy">查看隐私与边界</Link>
        </div>
      </div>
      <div className="home-status-grid">
        <article className="capability-card accent-card"><p className="eyebrow">ENTRY GATE</p><h3>{planning.snapshot.setupConfirmed ? '内部测试边界已确认' : '尚未确认内部测试边界'}</h3><p>{planning.snapshot.setupConfirmed ? '可以写入虚拟规划版本。' : '确认前不会写入身体档案或规划。'}</p></article>
        <article className="capability-card"><p className="eyebrow">LOCAL VERSIONS</p><h3>{versions.bodyProfile === 0 ? '空规划库' : `档案 v${String(versions.bodyProfile)}`}</h3><p>目标 v{String(versions.goal)} · 训练 v{String(versions.trainingPlan)}</p></article>
      </div>
      <article className="capability-card technical-card"><div><p className="eyebrow">BROWSER CHECK</p><h3>关键能力检测</h3></div>{renderCapabilityItems(compatibility.unsupported)}<p>构建 {__WEB_BUILD_MODE__} · 版本 {__APP_VERSION__}</p></article>
    </section>
  );
}
