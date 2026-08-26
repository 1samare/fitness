import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import type { PlanningSetupFormInput } from './planning-form';
import {
  LocalPlanningFlowError,
  type LocalPlanningRuntime,
  type LocalPlanningSnapshot
} from './local-planning-runtime';

interface PlanningErrorNotice {
  readonly code: string;
  readonly message: string;
}

interface PlanningContextValue {
  readonly runtime: LocalPlanningRuntime;
  readonly snapshot: LocalPlanningSnapshot;
  readonly busy: boolean;
  readonly error: PlanningErrorNotice | null;
  confirmTestBoundary(): Promise<void>;
  submitSetup(form: PlanningSetupFormInput): Promise<void>;
  refresh(): Promise<void>;
  clearError(): void;
  execute(action: () => Promise<LocalPlanningSnapshot>): Promise<void>;
}

const PlanningContext = createContext<PlanningContextValue | null>(null);

function noticeFromError(error: unknown): PlanningErrorNotice {
  if (error instanceof LocalPlanningFlowError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'local_planning_unavailable',
    message: error instanceof Error ? error.message : '本地规划暂时不可用。'
  };
}

export function PlanningProvider({
  runtime,
  children
}: {
  readonly runtime: LocalPlanningRuntime;
  readonly children: ReactNode;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<LocalPlanningSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<PlanningErrorNotice | null>(null);

  useEffect(() => {
    let active = true;
    runtime.initialize()
      .then((next) => { if (active) setSnapshot(next); })
      .catch((reason: unknown) => { if (active) setError(noticeFromError(reason)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [runtime]);

  const perform = useCallback(async (
    action: () => Promise<LocalPlanningSnapshot>
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await action());
    } catch (reason: unknown) {
      setError(noticeFromError(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<PlanningContextValue | null>(() => {
    if (snapshot === null) return null;
    return {
      runtime,
      snapshot,
      busy,
      error,
      confirmTestBoundary: () => perform(() => runtime.confirmTestBoundary()),
      submitSetup: (form) => perform(() => runtime.submitSetup(form)),
      refresh: () => perform(() => runtime.refresh()),
      clearError: () => setError(null),
      execute: perform
    };
  }, [busy, error, perform, runtime, snapshot]);

  if (value === null) {
    return (
      <section className="panel startup-panel" aria-live="polite">
        <p className="eyebrow">LOCAL STARTUP</p>
        <h2>{error === null ? '正在打开本地测试空间' : '本地测试空间无法打开'}</h2>
        <p>{error?.message ?? '正在初始化 IndexedDB 与虚拟测试数据。'}</p>
        {error !== null && <code>{error.code}</code>}
      </section>
    );
  }
  return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningContextValue {
  const value = useContext(PlanningContext);
  if (value === null) throw new Error('usePlanning must be used inside PlanningProvider');
  return value;
}
