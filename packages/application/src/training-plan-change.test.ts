import { describe, expect, test } from 'vitest';
import { affectedTrainingDates } from './training-plan-change';

const session = (businessDate: string, durationMinutes = 60) => ({
  businessDate,
  sessionCode: '02054',
  durationMinutes
});

describe('affectedTrainingDates', () => {
  test('marks both dates when a future session moves', () => {
    expect(affectedTrainingDates(
      [session('2026-08-10')],
      [session('2026-08-12')],
      ['2026-08-10', '2026-08-11', '2026-08-12']
    )).toEqual(['2026-08-10', '2026-08-12']);
  });

  test('marks duration changes and cancellations without unrelated dates', () => {
    expect(affectedTrainingDates(
      [session('2026-08-10'), session('2026-08-12')],
      [session('2026-08-10', 45)],
      ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']
    )).toEqual(['2026-08-10', '2026-08-12']);
  });

  test('returns no dates for the same session values', () => {
    expect(affectedTrainingDates(
      [session('2026-08-10')],
      [session('2026-08-10')],
      ['2026-08-10']
    )).toEqual([]);
  });

  test('excludes changes outside the eligible date set', () => {
    expect(affectedTrainingDates(
      [session('2026-08-06')],
      [],
      ['2026-08-07', '2026-08-08']
    )).toEqual([]);
  });
});
