import { localTestPlanningDatasetV1Schema } from '@fitness/contracts';
import { describe, expect, it } from 'vitest';
import { sha256HexOfJson } from '../utils/sha256';
import {
  createBundledLocalTestDataset,
  localTestDatasetChecksumPayload
} from './bundled-test-dataset';

describe('createBundledLocalTestDataset', () => {
  it('creates a schema-valid graph whose records are all test fixtures', async () => {
    const dataset = await createBundledLocalTestDataset();

    expect(localTestPlanningDatasetV1Schema.parse(dataset)).toEqual(dataset);
    expect(dataset.nutritionSnapshots.every((record) => record.qualityStatus === 'test_fixture')).toBe(true);
    expect(dataset.recipeTemplates.every((record) => record.qualityStatus === 'test_fixture')).toBe(true);
    expect(dataset.dailyMenus.every((record) => record.qualityStatus === 'test_fixture')).toBe(true);
    expect(dataset.menuCatalog.qualityStatus).toBe('test_fixture');
  });

  it('stores the SHA-256 of the canonical dataset payload', async () => {
    const dataset = await createBundledLocalTestDataset();

    expect(dataset.checksumSha256).toBe(
      await sha256HexOfJson(localTestDatasetChecksumPayload(dataset))
    );
  });
});
