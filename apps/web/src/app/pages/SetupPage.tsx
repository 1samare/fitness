import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  buildTrainingDayRows,
  createDefaultPlanningSetupForm,
  type PlanningSetupFormInput,
  REVIEWED_TRAINING_OPTIONS
} from '../../features/planning/planning-form';
import {
  clearPlanningSetupDraft,
  loadPlanningSetupDraft,
  savePlanningSetupDraft
} from '../../features/planning/planning-draft';
import { usePlanning } from '../../features/planning/PlanningProvider';
import type { LocalPlanningContext } from '../../features/planning/local-planning-runtime';

function formFromContext(
  context: LocalPlanningContext,
  businessToday: string
): PlanningSetupFormInput {
  const fallback = createDefaultPlanningSetupForm(businessToday);
  const profile = context.bodyProfile?.payload;
  const goal = context.goal?.payload;
  const plan = context.trainingPlan?.payload;
  if (profile === undefined || goal === undefined || plan === undefined) return fallback;
  const sessions = new Map(plan.sessions.map((session) => [session.businessDate, session]));
  const trainingDays = buildTrainingDayRows(plan.weekStartDate).map((day) => {
    const session = sessions.get(day.businessDate);
    return session === undefined ? day : {
      ...day,
      enabled: true,
      sessionCode: session.sessionCode,
      durationMinutes: String(session.durationMinutes)
    };
  });
  return {
    ageYears: String(profile.ageYears),
    sexCode: String(profile.sexCode),
    heightCm: String(profile.heightCm),
    weightKg: String(profile.weightKg),
    healthScopeConfirmed: profile.healthScopeConfirmed,
    nonTrainingActivity: profile.nonTrainingActivity,
    allergens: profile.allergens.join('，'),
    avoidFoods: profile.avoidFoods.join('，'),
    dietPreferences: profile.dietPreferences.join('，'),
    goal: goal.goal,
    targetWeightKg: goal.targetWeightKg === undefined ? '' : String(goal.targetWeightKg),
    effectiveDate: goal.effectiveDate,
    targetDate: goal.targetDate,
    weekStartDate: plan.weekStartDate,
    trainingDays
  };
}

export function SetupPage(): JSX.Element {
  const planning = usePlanning();
  const navigate = useNavigate();
  const [form, setForm] = useState<PlanningSetupFormInput>(() => (
    loadPlanningSetupDraft(sessionStorage)
      ?? formFromContext(planning.snapshot.context, planning.runtime.businessToday)
  ));

  useEffect(() => { savePlanningSetupDraft(sessionStorage, form); }, [form]);

  function update<K extends keyof PlanningSetupFormInput>(
    field: K,
    value: PlanningSetupFormInput[K]
  ): void {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function changeWeekStart(value: string): void {
    try {
      setForm((current) => ({
        ...current,
        weekStartDate: value,
        trainingDays: buildTrainingDayRows(value)
      }));
    } catch {
      update('weekStartDate', value);
    }
  }

  function updateTrainingDay(
    index: number,
    patch: Partial<PlanningSetupFormInput['trainingDays'][number]>
  ): void {
    update('trainingDays', form.trainingDays.map((day, dayIndex) => (
      dayIndex === index ? { ...day, ...patch } : day
    )));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      await planning.submitSetup(form);
      clearPlanningSetupDraft(sessionStorage);
      navigate('/plan');
    } catch {
      // The shared error bus presents the mapped failure and preserves the draft.
    }
  }

  if (!planning.snapshot.setupConfirmed) {
    return (
      <section className="panel">
        <p className="eyebrow">SETUP LOCKED</p>
        <h2>请先确认内部测试边界</h2>
        <p>确认后才能写入虚拟身体档案和规划版本。</p>
        <Link className="text-link" to="/privacy">查看并确认边界</Link>
      </section>
    );
  }

  return (
    <section className="panel planning-panel">
      <p className="eyebrow">STRUCTURED PLANNING</p>
      <h2>身体档案与一周计划</h2>
      <p className="section-lead">字段只用于虚拟测试。训练消耗与日常活动分开计算，克数和热量不由模型生成。</p>
      <form className="planning-form" onSubmit={(event) => { submit(event).catch(() => undefined); }}>
        <fieldset>
          <legend>1. 身体档案</legend>
          <div className="form-grid">
            <label>年龄<input value={form.ageYears} inputMode="numeric" onChange={(event) => update('ageYears', event.target.value)} /></label>
            <label>公式性别<select value={form.sexCode} onChange={(event) => update('sexCode', event.target.value)}><option value="0">男</option><option value="1">女</option></select></label>
            <label>身高（cm）<input value={form.heightCm} inputMode="decimal" onChange={(event) => update('heightCm', event.target.value)} /></label>
            <label>体重（kg）<input value={form.weightKg} inputMode="decimal" onChange={(event) => update('weightKg', event.target.value)} /></label>
            <label>非训练活动<select value={form.nonTrainingActivity} onChange={(event) => update('nonTrainingActivity', event.target.value)}><option value="light">轻</option><option value="moderate">中</option><option value="heavy">重</option></select></label>
          </div>
          <label className="check-row"><input type="checkbox" checked={form.healthScopeConfirmed} onChange={(event) => update('healthScopeConfirmed', event.target.checked)} />已完成最小化健康排除项确认；取消时仍可保存，但不会生成个性化能量目标。</label>
          <div className="form-grid wide-fields">
            <label>过敏原（逗号分隔）<input value={form.allergens} onChange={(event) => update('allergens', event.target.value)} /></label>
            <label>忌口（逗号分隔）<input value={form.avoidFoods} onChange={(event) => update('avoidFoods', event.target.value)} /></label>
            <label>饮食偏好（逗号分隔）<input value={form.dietPreferences} onChange={(event) => update('dietPreferences', event.target.value)} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>2. 目标</legend>
          <div className="form-grid">
            <label>目标<select aria-label="健身目标" value={form.goal} onChange={(event) => update('goal', event.target.value)}><option value="maintain">维持</option><option value="fat_loss">减脂</option><option value="muscle_gain">增肌</option></select></label>
            <label>目标体重（可选 kg）<input value={form.targetWeightKg} inputMode="decimal" onChange={(event) => update('targetWeightKg', event.target.value)} /></label>
            <label>生效日期<input type="date" value={form.effectiveDate} onChange={(event) => update('effectiveDate', event.target.value)} /></label>
            <label>目标日期<input type="date" value={form.targetDate} onChange={(event) => update('targetDate', event.target.value)} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>3. 七日训练计划</legend>
          <label className="week-field">规划周首日<input type="date" value={form.weekStartDate} onChange={(event) => changeWeekStart(event.target.value)} /></label>
          <div className="training-grid">
            {form.trainingDays.map((day, index) => (
              <article className={day.enabled ? 'training-day active' : 'training-day'} key={day.businessDate}>
                <label className="check-row compact"><input type="checkbox" checked={day.enabled} onChange={(event) => updateTrainingDay(index, { enabled: event.target.checked })} />{day.businessDate}</label>
                <select aria-label={`${day.businessDate} 训练类别`} disabled={!day.enabled} value={day.sessionCode} onChange={(event) => updateTrainingDay(index, { sessionCode: event.target.value })}>
                  <option value="">选择审核训练类别</option>
                  {REVIEWED_TRAINING_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                </select>
                <input aria-label={`${day.businessDate} 训练分钟`} disabled={!day.enabled} inputMode="numeric" placeholder="分钟" value={day.durationMinutes} onChange={(event) => updateTrainingDay(index, { durationMinutes: event.target.value })} />
              </article>
            ))}
          </div>
        </fieldset>

        {planning.error !== null && <div className="error-notice" role="alert"><strong>{planning.error.code}</strong><span>{planning.error.message}</span></div>}
        <button className="primary-button" type="submit" disabled={planning.busy}>{planning.busy ? '正在保存…' : '保存并计算七日目标'}</button>
      </form>
    </section>
  );
}
