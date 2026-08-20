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

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label} test fixture`);
  return value;
}

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
    expectInvalid((candidate) => {
      required(candidate.sourceReferences[0], 'source reference').authorizationEvidenceRef = ' ';
    });
    expectInvalid((candidate) => {
      required(candidate.sourceReferences[0], 'source reference').cacheAllowed = false as true;
    });
    expectInvalid((candidate) => {
      required(candidate.sourceReferences[0], 'source reference').displayAllowed = false as true;
    });
    expectInvalid((candidate) => {
      const source = required(candidate.sourceReferences[0], 'source reference');
      source.authorizationValidUntil = null;
      source.noExpiryBasis = null;
    });
    expectInvalid((candidate) => {
      required(candidate.sourceReferences[0], 'source reference').noExpiryBasis = 'perpetual-license';
    });
    expectInvalid((candidate) => {
      required(candidate.sourceReferences[0], 'source reference').exitDisposition =
        'delete_all' as 'retain_historical_only';
    });
  });

  test('rejects duplicate IDs and mismatched dataset/source metadata', () => {
    expectInvalid((candidate) => {
      candidate.nutritionSnapshots.push(structuredClone(required(
        candidate.nutritionSnapshots[0],
        'nutrition snapshot'
      )));
    });
    expectInvalid((candidate) => {
      required(candidate.recipeTemplates[0], 'recipe template').datasetVersion = 'other-version';
    });
    expectInvalid((candidate) => {
      required(candidate.dailyMenus[0], 'daily menu').sourceId = 'missing-source';
    });
    expectInvalid((candidate) => { candidate.menuCatalog.reviewedAt = '2026-08-02T00:00:00.000Z'; });
  });

  test('rejects every broken or dangling graph edge', () => {
    expectInvalid((candidate) => {
      const recipe = required(candidate.recipeTemplates[0], 'recipe template');
      required(recipe.ingredients[0], 'recipe ingredient').nutritionSnapshotId = 'missing-snapshot';
    });
    expectInvalid((candidate) => {
      const recipe = required(candidate.recipeTemplates[0], 'recipe template');
      required(recipe.ingredients[0], 'recipe ingredient').foodId = 'wrong-food';
    });
    expectInvalid((candidate) => {
      const menu = required(candidate.dailyMenus[0], 'daily menu');
      required(menu.meals[0], 'daily menu meal').recipeTemplateVersionId = 'missing-recipe';
    });
    expectInvalid((candidate) => {
      candidate.menuCatalog.dailyMenuTemplateVersionIds[0] = 'missing-menu';
    });
    expectInvalid((candidate) => {
      candidate.menuCatalog.dailyMenuTemplateVersionIds.pop();
    });
    expectInvalid((candidate) => {
      candidate.dailyMenus.push({
        ...structuredClone(required(candidate.dailyMenus[0], 'daily menu')),
        id: 'dangling-menu-v1'
      });
    });
    expectInvalid((candidate) => {
      candidate.recipeTemplates.push({
        ...structuredClone(required(candidate.recipeTemplates[0], 'recipe template')),
        id: 'dangling-recipe-v1',
        templateId: 'dangling-recipe'
      });
    });
    expectInvalid((candidate) => {
      candidate.nutritionSnapshots.push({
        ...structuredClone(required(candidate.nutritionSnapshots[0], 'nutrition snapshot')),
        id: 'dangling-snapshot-v1',
        foodId: 'dangling-food',
        sourceRecordId: 'dangling-source-record'
      });
    });
  });
});
