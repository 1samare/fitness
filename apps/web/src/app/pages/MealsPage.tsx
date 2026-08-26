import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlanning } from '../../features/planning/PlanningProvider';

interface InventoryDraftRow {
  readonly name: string;
  readonly availableGrams: string;
}

export function MealsPage(): JSX.Element {
  const planning = usePlanning();
  const context = planning.snapshot.context;
  const [inventoryRows, setInventoryRows] = useState<readonly InventoryDraftRow[]>(() => (
    planning.snapshot.testFoods.map((food) => ({
      name: food.canonicalNameZh,
      availableGrams: '50000'
    }))
  ));
  const [moveFrom, setMoveFrom] = useState(
    context.trainingPlan?.payload.sessions[0]?.businessDate ?? ''
  );
  const [moveTo, setMoveTo] = useState('');

  function run(action: () => ReturnType<typeof planning.runtime.refresh>): void {
    planning.execute(action).catch(() => undefined);
  }

  function saveInventory(): void {
    run(() => planning.runtime.saveInventory(inventoryRows.map((row) => ({
      name: row.name,
      availableGrams: Number(row.availableGrams)
    }))));
  }

  if (context.trainingPlan === null || context.dailyNutritionTargets.length !== 7) {
    return (
      <section className="panel">
        <p className="eyebrow">MEAL PREREQUISITES</p>
        <h2>请先完成受支持的七日规划</h2>
        <p>餐单只会使用已有的确定性能量/营养目标和显式测试库存。</p>
        <Link className="text-link" to="/setup">返回结构化建档</Link>
      </section>
    );
  }
  const trainingPlan = context.trainingPlan;

  return (
    <section className="panel meals-panel">
      <div className="section-heading">
        <div><p className="eyebrow">FIXTURE MEAL LOOP</p><h2>测试库存与七日餐单</h2></div>
        <p className="fixture-stamp">TEST_FIXTURE<br />仅合成数据</p>
      </div>
      <p className="section-lead">库存名称先映射到内部测试食材，再由每 100 克营养快照和实际克数复算。过敏原是硬约束，失败时不会放宽。</p>

      <section className="workflow-block">
        <div className="workflow-heading">
          <div><p className="eyebrow">STEP 01</p><h3>测试库存</h3></div>
          <strong>{context.inventory === null ? '尚未保存' : `库存版本 v${String(context.inventory.version)}`}</strong>
        </div>
        <div className="inventory-grid">
          {inventoryRows.map((row, index) => (
            <label key={`${row.name}-${String(index)}`}>
              {row.name}
              <span className="input-with-unit">
                <input
                  aria-label={`${row.name} 可用克数`}
                  inputMode="numeric"
                  value={row.availableGrams}
                  onChange={(event) => setInventoryRows(inventoryRows.map((item, rowIndex) => (
                    rowIndex === index ? { ...item, availableGrams: event.target.value } : item
                  )))}
                />
                <small>g</small>
              </span>
            </label>
          ))}
        </div>
        <div className="action-row">
          <button className="primary-button" type="button" disabled={planning.busy || inventoryRows.length === 0} onClick={saveInventory}>保存测试库存</button>
          <button className="secondary-button" type="button" disabled={planning.busy || context.inventory === null} onClick={() => run(() => planning.runtime.generateMealPlan())}>生成确定性七日餐单</button>
        </div>
      </section>

      {planning.error !== null && <div className="error-notice" role="alert"><strong>{planning.error.code}</strong><span>{planning.error.message}</span></div>}

      {context.retryableRecalculationJob !== null && (
        <section className="recovery-strip">
          <div><strong>重算可重试</strong><p>{context.retryableRecalculationJob.failureCode ?? 'provider_unavailable'}</p></div>
          <button className="secondary-button" type="button" disabled={planning.busy} onClick={() => run(() => planning.runtime.retryPendingRecalculation())}>重试重算</button>
        </section>
      )}

      {context.pendingMealPlanCandidate !== null && (
        <section className="candidate-panel">
          <p className="eyebrow">CONFIRM REQUIRED</p>
          <h3>锁定或手改日期不会被静默覆盖</h3>
          <p>待确认餐单 v{String(context.pendingMealPlanCandidate.version)}，影响 {String(context.pendingMealPlanTargetDiffs.length)} 天。</p>
          <ul>{context.pendingMealPlanTargetDiffs.map((diff) => <li key={diff.id}>{diff.businessDate} · 目标与餐食差异已生成</li>)}</ul>
          <div className="action-row">
            <button className="secondary-button" type="button" onClick={() => run(() => planning.runtime.decidePendingMealPlan('keep_existing'))}>保留现有锁定餐单</button>
            <button className="primary-button" type="button" onClick={() => run(() => planning.runtime.decidePendingMealPlan('overwrite_locked'))}>确认覆盖受影响日期</button>
          </div>
        </section>
      )}

      {context.mealPlan !== null && (
        <>
          <section className="workflow-block training-control">
            <div className="workflow-heading"><div><p className="eyebrow">TRAINING LINK</p><h3>训练变更与完成度</h3></div><strong>训练版本 v{String(trainingPlan.version)}</strong></div>
            <div className="inline-form">
              <label>移动来源<select value={moveFrom} onChange={(event) => setMoveFrom(event.target.value)}><option value="">选择训练日</option>{trainingPlan.payload.sessions.map((session) => <option key={session.businessDate} value={session.businessDate}>{session.businessDate}</option>)}</select></label>
              <label>移动目标<input type="date" value={moveTo} onChange={(event) => setMoveTo(event.target.value)} /></label>
              <button className="secondary-button" type="button" disabled={moveFrom === '' || moveTo === ''} onClick={() => run(() => planning.runtime.moveTrainingSession(moveFrom, moveTo))}>移动并重算</button>
            </div>
          </section>

          <div className="meal-week-heading"><div><p className="eyebrow">STEP 02</p><h3>餐单版本 v{String(context.mealPlan.version)}</h3></div><p>{context.mealPlanStale ? '库存已变化，当前餐单待更新' : '当前餐单与活动版本一致'}</p></div>
          <div className="meal-day-grid">
            {context.mealPlan.days.map((day) => (
              <article className={day.locked ? 'meal-day-card locked' : 'meal-day-card'} key={day.businessDate}>
                <header><div><p className="eyebrow">{day.manuallyModified ? 'MANUAL + LOCKED' : day.locked ? 'LOCKED' : 'PLANNED'}</p><h3>{day.businessDate}</h3></div><button className="tiny-button" type="button" onClick={() => run(() => planning.runtime.setMealPlanDayLock(day.businessDate, !day.locked))}>{day.locked ? '解除锁定' : '锁定此日'}</button></header>
                <p className="daily-total">全天营养估算 · {String(day.nutritionTotals.energyKcal)} kcal · 蛋白质 {String(day.nutritionTotals.proteinG)} g</p>
                <div className="meal-list">
                  {day.meals.map((meal) => (
                    <section key={meal.slot}>
                      <div><span>{meal.slot}</span><strong>{meal.dishNameZh ?? '菜品名称暂不可用'}</strong></div>
                      <p>{(meal.ingredients ?? []).map((ingredient) => `${ingredient.displayNameZh} ${String(ingredient.grams)}g`).join(' · ')}</p>
                      <div className="meal-actions">
                        <button type="button" onClick={() => run(() => planning.runtime.resizeMealPortion(day.businessDate, meal.slot, Math.max(0.5, meal.servingMultiplier - 0.1)))}>份量 -10%</button>
                        <button type="button" onClick={() => run(() => planning.runtime.resizeMealPortion(day.businessDate, meal.slot, Math.min(2, meal.servingMultiplier + 0.1)))}>份量 +10%</button>
                        <select aria-label={`${day.businessDate} ${meal.slot} 换菜`} defaultValue="" disabled={context.selectableRecipesStatus !== 'available'} onChange={(event) => {
                          if (event.target.value !== '') run(() => planning.runtime.replaceMeal(day.businessDate, meal.slot, event.target.value));
                        }}>
                          <option value="">换菜…</option>
                          {context.selectableRecipes.map((recipe) => <option key={recipe.recipeTemplateVersionId} value={recipe.recipeTemplateVersionId}>{recipe.dishNameZh}</option>)}
                        </select>
                      </div>
                    </section>
                  ))}
                </div>
                {trainingPlan.payload.sessions.some((session) => session.businessDate === day.businessDate) && (
                  <button className="completion-button" type="button" onClick={() => {
                    const session = trainingPlan.payload.sessions.find((item) => item.businessDate === day.businessDate);
                    if (session !== undefined) run(() => planning.runtime.recordTrainingCompletion(day.businessDate, session.durationMinutes));
                  }}>按计划完成训练并重算</button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
