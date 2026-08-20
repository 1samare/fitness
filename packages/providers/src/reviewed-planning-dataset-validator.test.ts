import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  createReviewedPlanningDatasetCandidate,
  REVIEWED_DATASET_NOW
} from './reviewed-planning-dataset.test-support';
import {
  canonicalReviewedDatasetPayload,
  InvalidReviewedPlanningDatasetError,
  validateReviewedPlanningDataset
} from './reviewed-planning-dataset-validator';

function withChecksum(candidate = createReviewedPlanningDatasetCandidate()) {
  candidate.checksumSha256 = createHash('sha256')
    .update(canonicalReviewedDatasetPayload(candidate), 'utf8')
    .digest('hex');
  return candidate;
}

function expectInvalid(mutate: (candidate: ReturnType<typeof createReviewedPlanningDatasetCandidate>) => void) {
  const candidate = createReviewedPlanningDatasetCandidate();
  mutate(candidate);
  expect(() => validateReviewedPlanningDataset(withChecksum(candidate), REVIEWED_DATASET_NOW))
    .toThrow(InvalidReviewedPlanningDatasetError);
}

describe('validateReviewedPlanningDataset', () => {
  test('accepts a checksummed, licensed and fully closed graph', () => {
    const candidate = withChecksum();
    expect(validateReviewedPlanningDataset(candidate, REVIEWED_DATASET_NOW)).toEqual(candidate);
  });

  test('canonical payload is stable across object key order and omits checksum', () => {
    const candidate = createReviewedPlanningDatasetCandidate();
    const reordered = Object.fromEntries(Object.entries(candidate).reverse());
    expect(canonicalReviewedDatasetPayload(reordered as typeof candidate))
      .toBe(canonicalReviewedDatasetPayload(candidate));
    expect(canonicalReviewedDatasetPayload(candidate)).not.toContain('checksumSha256');
  });

  test('rejects checksum, time, approval and license failures', () => {
    const mismatch = withChecksum();
    mismatch.checksumSha256 = 'f'.repeat(64);
    expect(() => validateReviewedPlanningDataset(mismatch, REVIEWED_DATASET_NOW))
      .toThrow(InvalidReviewedPlanningDatasetError);

    expectInvalid((candidate) => { candidate.activatedAt = '2026-07-01T00:00:00.000Z'; });
    expectInvalid((candidate) => { candidate.validUntil = REVIEWED_DATASET_NOW; });
    expectInvalid((candidate) => { candidate.sourceReferences[0]!.authorizationEvidenceRef = ' '; });
    expectInvalid((candidate) => { candidate.sourceReferences[0]!.cacheAllowed = false as true; });
    expectInvalid((candidate) => { candidate.sourceReferences[0]!.displayAllowed = false as true; });
    expectInvalid((candidate) => {
      candidate.sourceReferences[0]!.authorizationValidUntil = null;
      candidate.sourceReferences[0]!.noExpiryBasis = null;
    });
    expectInvalid((candidate) => {
      candidate.sourceReferences[0]!.noExpiryBasis = 'perpetual-license';
    });
    expectInvalid((candidate) => {
      candidate.sourceReferences[0]!.exitDisposition = 'delete_all' as 'retain_historical_only';
    });
  });

  test('rejects duplicate IDs and mismatched dataset/source metadata', () => {
    expectInvalid((candidate) => {
      candidate.nutritionSnapshots.push(structuredClone(candidate.nutritionSnapshots[0]!));
    });
    expectInvalid((candidate) => { candidate.recipeTemplates[0]!.datasetVersion = 'other-version'; });
    expectInvalid((candidate) => { candidate.dailyMenus[0]!.sourceId = 'missing-source'; });
    expectInvalid((candidate) => { candidate.menuCatalog.reviewedAt = '2026-08-02T00:00:00.000Z'; });
  });

  test('rejects every broken or dangling graph edge', () => {
    expectInvalid((candidate) => {
      candidate.recipeTemplates[0]!.ingredients[0]!.nutritionSnapshotId = 'missing-snapshot';
    });
    expectInvalid((candidate) => {
      candidate.recipeTemplates[0]!.ingredients[0]!.foodId = 'wrong-food';
    });
    expectInvalid((candidate) => {
      candidate.dailyMenus[0]!.meals[0]!.recipeTemplateVersionId = 'missing-recipe';
    });
    expectInvalid((candidate) => {
      candidate.menuCatalog.dailyMenuTemplateVersionIds[0] = 'missing-menu';
    });
    expectInvalid((candidate) => {
      candidate.menuCatalog.dailyMenuTemplateVersionIds.pop();
    });
    expectInvalid((candidate) => {
      candidate.dailyMenus.push({
        ...structuredClone(candidate.dailyMenus[0]!),
        id: 'dangling-menu-v1'
      });
    });
    expectInvalid((candidate) => {
      candidate.recipeTemplates.push({
        ...structuredClone(candidate.recipeTemplates[0]!),
        id: 'dangling-recipe-v1',
        templateId: 'dangling-recipe'
      });
    });
    expectInvalid((candidate) => {
      candidate.nutritionSnapshots.push({
        ...structuredClone(candidate.nutritionSnapshots[0]!),
        id: 'dangling-snapshot-v1',
        foodId: 'dangling-food',
        sourceRecordId: 'dangling-source-record'
      });
    });
  });
});
