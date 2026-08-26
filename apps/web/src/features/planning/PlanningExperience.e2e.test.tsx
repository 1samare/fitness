import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { AppRouteElements } from '../../app/routes';
import { FitnessLocalDatabase } from '../../db/database';
import { createDefaultPlanningSetupForm } from './planning-form';
import { PlanningProvider } from './PlanningProvider';
import { createLocalPlanningRuntime } from './local-planning-runtime';

const databases: FitnessLocalDatabase[] = [];
let databaseSequence = 0;

function createRuntime() {
  const database = new FitnessLocalDatabase(`planning-ui-${String(++databaseSequence)}`);
  databases.push(database);
  let sequence = 0;
  return {
    database,
    runtime: createLocalPlanningRuntime({
      database,
      now: () => '2026-08-26T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-${String(++sequence)}`,
      nextIdempotencyKey: () => `ui-command-${String(++sequence).padStart(4, '0')}`
    })
  };
}

afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe('structured local planning Web experience', () => {
  test('moves from an empty database through confirmation and setup to seven daily targets', async () => {
    const { runtime } = createRuntime();
    render(
      <MemoryRouter initialEntries={['/']}>
        <PlanningProvider runtime={runtime}>
          <AppRouteElements />
        </PlanningProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('尚未确认内部测试边界')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认边界并继续' }));
    expect(await screen.findByText('内部测试边界已确认')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '开始结构化建档' }));

    expect(await screen.findByRole('heading', { name: '身体档案与一周计划' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存并计算七日目标' }));

    expect(await screen.findByRole('heading', { name: '每日能量与营养目标' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText('估算目标').length).toBe(7);
    });
    expect(screen.getByText('档案 v1 · 目标 v1 · 训练 v1')).toBeTruthy();
    expect(screen.getByText('2026-08-26')).toBeTruthy();
  });

  test('renders the deterministic unsupported result without nutrition numbers', async () => {
    const { runtime } = createRuntime();
    await runtime.initialize();
    await runtime.confirmTestBoundary();
    await runtime.submitSetup({
      ...createDefaultPlanningSetupForm('2026-08-26'),
      ageYears: '46',
      healthScopeConfirmed: false
    });

    render(
      <MemoryRouter initialEntries={['/plan']}>
        <PlanningProvider runtime={runtime}>
          <AppRouteElements />
        </PlanningProvider>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: '每日能量与营养目标' })).toBeTruthy();
    expect(screen.getAllByText('暂不支持个性化能量与营养目标')).toHaveLength(7);
    expect(screen.queryByText(/蛋白质/)).toBeNull();
  });
});
