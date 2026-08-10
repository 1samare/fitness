export const REVIEWED_MET_DATASET = Object.freeze({
  datasetVersion: '2024.1',
  sourceId: 'MET-COMPENDIUM-2024' as const,
  reviewedAt: '2026-08-10',
  sessions: [
    {
      code: '02050',
      met: 6,
      displayNameZh: '大强度抗阻训练',
      originalUnit: 'MET',
      activityCategory: 'conditioning_exercise',
      trainingKind: 'regular_resistance',
      description: 'Resistance (weight lifting - free weight, nautilus or universal-type), power lifting or body building, vigorous effort'
    },
    {
      code: '02052',
      met: 5,
      displayNameZh: '深蹲或硬拉训练',
      originalUnit: 'MET',
      activityCategory: 'conditioning_exercise',
      trainingKind: 'regular_resistance',
      description: 'Resistance (weight) training, squats, deadlift, slow or explosive effort'
    },
    {
      code: '02054',
      met: 3.5,
      displayNameZh: '多动作抗阻训练',
      originalUnit: 'MET',
      activityCategory: 'conditioning_exercise',
      trainingKind: 'regular_resistance',
      description: 'Resistance (weight) training, multiple exercises, 8-15 reps at varied resistance'
    }
  ] as const
});
