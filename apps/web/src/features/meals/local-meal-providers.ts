import type { MealPlanningProviders } from '@fitness/application/browser';
import type { LocalTestPlanningDatasetV1 } from '@fitness/contracts';
import {
  type FitnessLocalDatabase,
  LOCAL_USER_ID
} from '../../db/database';

async function selectedDataset(
  database: FitnessLocalDatabase
): Promise<LocalTestPlanningDatasetV1> {
  const settings = await database.appSettings.get(LOCAL_USER_ID);
  const selected = settings?.selectedDataset;
  if (selected === null || selected === undefined) {
    throw new Error('No local test dataset is selected');
  }
  const row = await database.testDatasets.get(
    `${selected.datasetId}@${selected.datasetVersion}`
  );
  if (row === undefined) throw new Error('Selected local test dataset is missing');
  return structuredClone(row.dataset);
}

export function createLocalMealPlanningProviders(
  database: FitnessLocalDatabase
): MealPlanningProviders {
  return {
    allowTestFixtures: true,
    nutrition: {
      async getSnapshot(snapshotId) {
        const dataset = await selectedDataset(database);
        const snapshot = dataset.nutritionSnapshots.find((item) => item.id === snapshotId);
        if (snapshot === undefined) throw new Error('Nutrition snapshot is missing');
        return structuredClone(snapshot);
      },
      async resolveCanonicalName(name) {
        const normalized = name.trim().toLocaleLowerCase('zh-CN');
        const dataset = await selectedDataset(database);
        const snapshot = dataset.nutritionSnapshots.find((item) => (
          item.canonicalNameZh.toLocaleLowerCase('zh-CN') === normalized
          || item.foodId.toLocaleLowerCase('en-US') === normalized
        ));
        return snapshot === undefined ? null : {
          foodId: snapshot.foodId,
          canonicalNameZh: snapshot.canonicalNameZh,
          nutritionSnapshotId: snapshot.id
        };
      }
    },
    recipes: {
      async getByVersionId(versionId) {
        const dataset = await selectedDataset(database);
        const recipe = dataset.recipeTemplates.find((item) => item.id === versionId);
        if (recipe === undefined) throw new Error('Recipe template is missing');
        return structuredClone(recipe);
      }
    },
    menus: {
      async getActiveCatalog() {
        return structuredClone((await selectedDataset(database)).menuCatalog);
      },
      async getMenuByVersionId(versionId) {
        const dataset = await selectedDataset(database);
        const menu = dataset.dailyMenus.find((item) => item.id === versionId);
        if (menu === undefined) throw new Error('Daily menu is missing');
        return structuredClone(menu);
      }
    }
  };
}

export async function readLocalTestFoods(database: FitnessLocalDatabase): Promise<readonly {
  readonly foodId: string;
  readonly canonicalNameZh: string;
  readonly nutritionSnapshotId: string;
  readonly foodState: 'raw' | 'cooked' | 'dry';
}[]> {
  try {
    const dataset = await selectedDataset(database);
    return dataset.nutritionSnapshots.map((snapshot) => ({
      foodId: snapshot.foodId,
      canonicalNameZh: snapshot.canonicalNameZh,
      nutritionSnapshotId: snapshot.id,
      foodState: snapshot.foodState
    }));
  } catch {
    return [];
  }
}
