import {
  localTestPlanningDatasetV1Schema,
  type LocalTestPlanningDatasetV1
} from '@fitness/contracts';
import {
  TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
  TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES,
  TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS,
  TEST_MEAL_PLANNING_RECIPE_TEMPLATES
} from '@fitness/nutrition-fixtures';
import { sha256HexOfJson } from '../utils/sha256';

const DATASET_VERSION = 'local-test-2026-08-26';
const SOURCE_ID = 'FITNESS-TEST-FIXTURE-BALANCED-MEAL-V1';
const CREATED_AT = '2026-08-26T00:00:00.000Z';

export function localTestDatasetChecksumPayload(
  dataset: LocalTestPlanningDatasetV1
): Omit<LocalTestPlanningDatasetV1, 'checksumSha256'> {
  return {
    schemaVersion: dataset.schemaVersion,
    datasetId: dataset.datasetId,
    datasetVersion: dataset.datasetVersion,
    qualityStatus: dataset.qualityStatus,
    createdAt: dataset.createdAt,
    sourceReferences: dataset.sourceReferences,
    nutritionSnapshots: dataset.nutritionSnapshots,
    recipeTemplates: dataset.recipeTemplates,
    dailyMenus: dataset.dailyMenus,
    menuCatalog: dataset.menuCatalog
  };
}

export async function createBundledLocalTestDataset(): Promise<LocalTestPlanningDatasetV1> {
  const nutritionSnapshots = structuredClone(TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS);
  const recipeTemplates = structuredClone(TEST_MEAL_PLANNING_RECIPE_TEMPLATES);
  const dailyMenus = structuredClone(TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES);
  const menuCatalog = structuredClone(TEST_MEAL_PLANNING_DAILY_MENU_CATALOG);  const candidate = localTestPlanningDatasetV1Schema.parse({
    schemaVersion: 'local-test-planning-dataset-v1',
    datasetId: 'local-test-planning-cn-v1',
    datasetVersion: DATASET_VERSION,
    qualityStatus: 'test_fixture',
    createdAt: CREATED_AT,
    checksumSha256: '0'.repeat(64),
    sourceReferences: [{
      sourceId: SOURCE_ID,
      title: '仅供自动化与内部测试的合成数据',
      version: '2026-08-26',
      fixtureNotice: 'synthetic_test_data_only'
    }],
    nutritionSnapshots,
    recipeTemplates,
    dailyMenus,
    menuCatalog
  });
  const checksumSha256 = await sha256HexOfJson(localTestDatasetChecksumPayload(candidate));
  return localTestPlanningDatasetV1Schema.parse({ ...candidate, checksumSha256 });
}
