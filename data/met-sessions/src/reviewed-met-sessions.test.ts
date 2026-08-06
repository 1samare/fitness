import { describe, expect, it } from 'vitest';
import { REVIEWED_MET_DATASET } from './reviewed-met-sessions';

describe('reviewed MET dataset', () => {
  it('preserves the source chain for session 02054', () => {
    expect(REVIEWED_MET_DATASET).toMatchObject({
      datasetVersion: '2024.1',
      sourceId: 'MET-COMPENDIUM-2024',
      reviewedAt: '2026-07-30'
    });
    expect(REVIEWED_MET_DATASET.sessions).toEqual([
      {
        code: '02054',
        met: 3.5,
        originalUnit: 'MET',
        activityCategory: 'conditioning_exercise',
        description: 'Resistance (weight) training, multiple exercises, 8-15 reps at varied resistance'
      }
    ]);
  });
});
