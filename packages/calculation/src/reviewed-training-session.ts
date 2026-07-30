import { REVIEWED_MET_DATASET } from '@fitness/met-sessions';
import type { ReviewedTrainingSession } from '@fitness/domain';

export function findReviewedTrainingSession(code: string): ReviewedTrainingSession | undefined {
  const record = REVIEWED_MET_DATASET.sessions.find((session) => session.code === code);
  if (record === undefined) return undefined;
  return {
    ...record,
    sourceId: REVIEWED_MET_DATASET.sourceId,
    datasetVersion: REVIEWED_MET_DATASET.datasetVersion,
    reviewedAt: REVIEWED_MET_DATASET.reviewedAt
  };
}
