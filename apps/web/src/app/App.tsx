import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, NavLink, useLocation } from 'react-router-dom';
import { APP_ROUTES, AppRouteElements } from './routes';
import { detectBrowserCapabilities } from '../features/capability-check/capability-check';
import { FitnessLocalDatabase } from '../db/database';
import { PlanningProvider, usePlanning } from '../features/planning/PlanningProvider';
import { createLocalPlanningRuntime } from '../features/planning/local-planning-runtime';
import type { LocalAssistantRuntime } from '../features/assistant/local-assistant-runtime';
import {
  createLocalImageCandidateRuntime,
  type LocalImageCandidateRuntime
} from '../features/ingredient-photo/local-image-candidate-runtime';
import {
  createBuildBrowserProviderBundle,
  type BrowserProviderBundle
} from '../llm/browser-provider-bundle';
import {
  createAssistantPageRuntime,
  createIngredientPhotoPageRuntime
} from './browser-ai-page-runtimes';
import { createBrowserDataPageRuntime } from './browser-data-page-runtime';

const CAPABILITY_ERROR_CODE = 'browser_capability_unsupported';

function isCapabilitySupported(): boolean {
  return detectBrowserCapabilities().supported;
}

export function App(): JSX.Element {
  const browserReady = isCapabilitySupported();

  return (
    <BrowserRouter>
      <header className="app-header">
        <div><p className="eyebrow">FITNESS / LOCAL</p><h1>一周规划实验室</h1></div>
        <p className="internal-badge">内部虚拟测试 · 估算值 · AI 辅助 · 非医疗建议</p>
      </header>
      {browserReady ? <ReadyApplication /> : (
        <section className="panel">
          <h2>启动受限</h2>
          <p>错误码：{CAPABILITY_ERROR_CODE}</p>
          <p>当前环境缺少关键浏览器能力，无法进入业务页面。</p>
          <p>请切换到支持 IndexedDB、Web Crypto、BroadcastChannel 与结构化克隆的现代浏览器。</p>
        </section>
      )}
    </BrowserRouter>
  );
}

function ReadyApplication(): JSX.Element {
  const [application] = useState(() => {
    const database = new FitnessLocalDatabase();
    const providerBundle = createBuildBrowserProviderBundle();
    return {
      database,
      providerBundle,
      planning: createLocalPlanningRuntime({ database }),
      data: createBrowserDataPageRuntime({ database }),
      ingredientPhoto: providerBundle === null
        ? undefined
        : createLocalImageCandidateRuntime({ database, vision: providerBundle.visionBackend })
    };
  });
  return (
    <PlanningProvider runtime={application.planning}>
      <nav className="app-nav" aria-label="主导航">{APP_ROUTES.map((route) => <NavLink key={route.path} to={route.path} className={({ isActive }) => isActive ? 'active' : undefined}>{route.title}</NavLink>)}</nav>
      <PlanningStatus />
      <main className="app-main">
        <ConnectedRoutes
          database={application.database}
          providerBundle={application.providerBundle}
          ingredientPhotoRuntime={application.ingredientPhoto}
          dataRuntime={application.data}
        />
      </main>
    </PlanningProvider>
  );
}

function ConnectedRoutes({
  database,
  providerBundle,
  ingredientPhotoRuntime,
  dataRuntime
}: {
  readonly database: FitnessLocalDatabase;
  readonly providerBundle: BrowserProviderBundle | null;
  readonly ingredientPhotoRuntime?: LocalImageCandidateRuntime | undefined;
  readonly dataRuntime: ReturnType<typeof createBrowserDataPageRuntime>;
}): JSX.Element {
  const planning = usePlanning();
  const location = useLocation();
  const [assistantRuntime, setAssistantRuntime] = useState<LocalAssistantRuntime | undefined>();
  const refreshPlanning = useRef(planning.refresh);
  refreshPlanning.current = planning.refresh;
  useEffect(() => {
    if (location.pathname !== '/assistant'
      || providerBundle === null
      || assistantRuntime !== undefined) return undefined;
    let active = true;
    void import('../features/assistant/local-assistant-runtime').then((module) => {
      if (active) {
        setAssistantRuntime(module.createLocalAssistantRuntime({
          database,
          provider: providerBundle.languageModelProvider
        }));
      }
    });
    return () => { active = false; };
  }, [assistantRuntime, database, location.pathname, providerBundle]);
  const assistantPageRuntime = useMemo(
    () => assistantRuntime === undefined
      ? undefined
      : createAssistantPageRuntime(assistantRuntime, () => refreshPlanning.current()),
    [assistantRuntime]
  );
  const ingredientPhotoPageRuntime = useMemo(
    () => ingredientPhotoRuntime === undefined
      ? undefined
      : createIngredientPhotoPageRuntime(ingredientPhotoRuntime, () => refreshPlanning.current()),
    [ingredientPhotoRuntime]
  );
  return (
    <AppRouteElements
      assistantRuntime={assistantPageRuntime}
      ingredientPhotoRuntime={ingredientPhotoPageRuntime}
      dataRuntime={dataRuntime}
    />
  );
}

function PlanningStatus(): JSX.Element {
  const planning = usePlanning();
  const versions = planning.snapshot.context.latestVersions;
  return <aside className="planning-status" aria-live="polite"><span>本地用户 local-default</span><span>档案 v{String(versions.bodyProfile)} / 目标 v{String(versions.goal)} / 训练 v{String(versions.trainingPlan)}</span>{planning.error !== null && <strong>{planning.error.code}</strong>}</aside>;
}
