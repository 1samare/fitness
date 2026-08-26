import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { AppRouteElements } from '../../app/routes';
import { FitnessLocalDatabase } from '../../db/database';
import { PlanningProvider } from '../planning/PlanningProvider';
import { createLocalPlanningRuntime } from '../planning/local-planning-runtime';
import { createDefaultPlanningSetupForm } from '../planning/planning-form';

const databases: FitnessLocalDatabase[] = [];
let databaseSequence = 0;

function createHarness() {
  const database = new FitnessLocalDatabase(`meal-ui-${String(++databaseSequence)}`);
  databases.push(database);
  let sequence = 0;
  return createLocalPlanningRuntime({
    database,
    now: () => '2026-08-26T08:00:00.000Z',
    nextId: (prefix) => `${prefix}-${String(++sequence)}`,
    nextIdempotencyKey: () => `meal-ui-command-${String(++sequence).padStart(4, '0')}`
  });
}

afterEach(async () => {
  cleanup();
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe('local meal planning Web experience', () => {
  test('runs inventory, meal editing, lock protection, training move and diff decision', async () => {
    const runtime = createHarness();
    await runtime.initialize();
    await runtime.confirmTestBoundary();
    const form = createDefaultPlanningSetupForm('2026-08-31');
    await runtime.submitSetup({
      ...form,
      goal: 'muscle_gain',
      trainingDays: form.trainingDays.map((day, index) => (
        index === 0 || index === 2
          ? {
              ...day,
              enabled: true,
              sessionCode: '02054',
              durationMinutes: '60'
            }
          : day
      ))
    });

    render(
      <MemoryRouter initialEntries={['/meals']}>
        <PlanningProvider runtime={runtime}>
          <AppRouteElements />
        </PlanningProvider>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: '测试库存与七日餐单' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存测试库存' }));
    expect(await screen.findByText('库存版本 v1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '生成确定性七日餐单' }));

    await waitFor(() => {
      expect(screen.getAllByText(/全天营养估算/)).toHaveLength(7);
    });
    fireEvent.change(screen.getByLabelText('2026-09-05 dinner 换菜'), {
      target: { value: 'recipe-version-fixture-balanced-meal-day-2-dinner-v1' }
    });
    expect(await screen.findByText('MANUAL + LOCKED')).toBeTruthy();

    const firstLockButton = screen.getAllByRole('button', { name: '锁定此日' })[0];
    if (firstLockButton === undefined) throw new Error('Expected first meal-plan lock button');
    fireEvent.click(firstLockButton);
    expect(await screen.findByRole('button', { name: '解除锁定' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('移动目标'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: '移动并重算' }));
    expect(await screen.findByRole('heading', { name: '锁定或手改日期不会被静默覆盖' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保留现有锁定餐单' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: '锁定或手改日期不会被静默覆盖' })).toBeNull();
    });
  });
});
