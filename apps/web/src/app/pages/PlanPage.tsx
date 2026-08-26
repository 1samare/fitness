import { Link } from 'react-router-dom';
import { usePlanning } from '../../features/planning/PlanningProvider';
import type { LocalPlanningContext } from '../../features/planning/local-planning-runtime';

type DailyTarget = LocalPlanningContext['dailyNutritionTargets'][number];

function DailyTargetCard({ target }: { readonly target: DailyTarget }): JSX.Element {
  if (target.energy.kind === 'unsupported' || target.nutrition === null) {
    return (
      <article className="target-card unsupported-card">
        <h3>{target.businessDate}</h3><span className="status-chip warning">范围外</span>
        <p>暂不支持个性化能量与营养目标</p>
        <code>{target.energy.kind === 'unsupported' ? target.energy.code : 'nutrition_unavailable'}</code>
      </article>
    );
  }
  if (target.nutrition.kind === 'infeasible') {
    return (
      <article className="target-card unsupported-card">
        <h3>{target.businessDate}</h3><span className="status-chip warning">约束无解</span>
        <p>{String(target.nutrition.targetEnergyKcal)} kcal（估算）</p><code>{target.nutrition.code}</code>
      </article>
    );
  }
  const nutrition = target.nutrition;
  return (
    <article className="target-card">
      <h3>{target.businessDate}</h3><span className="status-chip">估算目标</span>
      <p className="energy-number">{String(nutrition.targetEnergyKcal)} <small>kcal</small></p>
      <dl>
        <div><dt>蛋白质</dt><dd>{String(nutrition.proteinG)} g</dd></div>
        <div><dt>脂肪</dt><dd>{String(nutrition.fatG)} g</dd></div>
        <div><dt>碳水</dt><dd>{String(nutrition.carbohydrateG)} g</dd></div>
        <div><dt>纤维</dt><dd>{String(nutrition.fiberRangeG.minInclusive)}–{String(nutrition.fiberRangeG.maxInclusive)} g</dd></div>
      </dl>
      <p className="version-note">能量策略 {target.energyPolicyVersion} · 营养策略 {target.nutritionPolicyVersion}</p>
    </article>
  );
}

export function PlanPage(): JSX.Element {
  const { snapshot } = usePlanning();
  const context = snapshot.context;
  if (context.bodyProfile === null || context.goal === null || context.trainingPlan === null) {
    return (
      <section className="panel"><p className="eyebrow">NO ACTIVE PLAN</p><h2>还没有结构化规划</h2><p>先建立虚拟身体档案、目标和七日训练计划。</p><Link className="text-link" to="/setup">开始结构化建档</Link></section>
    );
  }
  return (
    <section className="panel targets-panel">
      <div className="section-heading"><div><p className="eyebrow">DETERMINISTIC TARGETS</p><h2>每日能量与营养目标</h2></div><Link className="secondary-button" to="/setup">建立新版本</Link></div>
      <p className="version-summary">档案 v{String(context.bodyProfile.version)} · 目标 v{String(context.goal.version)} · 训练 v{String(context.trainingPlan.version)}</p>
      <p className="section-lead">所有热量、训练消耗与克数均为估算值；过去版本保留，新提交不会原地覆盖历史。</p>
      <div className="target-grid">{context.dailyNutritionTargets.map((target) => <DailyTargetCard key={target.id} target={target} />)}</div>
    </section>
  );
}
