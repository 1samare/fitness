import { createBundledLocalTestDataset } from './bundled-test-dataset';
import {
  type AppSettingsRow,
  type FitnessLocalDatabase,
  LOCAL_DATABASE_SCHEMA_VERSION,
  LOCAL_USER_ID,
  type TestDatasetRow
} from './database';

export interface InitializeLocalDataResult {
  readonly settings: AppSettingsRow;
  readonly datasetRow: TestDatasetRow;
}

export async function initializeLocalData(
  database: FitnessLocalDatabase,
  now: string
): Promise<InitializeLocalDataResult> {
  const dataset = await createBundledLocalTestDataset();
  const datasetRow: TestDatasetRow = {
    key: `${dataset.datasetId}@${dataset.datasetVersion}`,
    datasetId: dataset.datasetId,
    datasetVersion: dataset.datasetVersion,
    importedAt: now,
    dataset
  };
  return database.transaction('rw', database.appSettings, database.testDatasets, async () => {
    const existingSettings = await database.appSettings.get(LOCAL_USER_ID);
    const settings: AppSettingsRow = existingSettings ?? {
      userId: LOCAL_USER_ID,
      schemaVersion: LOCAL_DATABASE_SCHEMA_VERSION,
      updatedAt: now,
      setupConfirmedAt: null,
      persistentStorageStatus: 'unknown',
      selectedDataset: {
        datasetId: dataset.datasetId,
        datasetVersion: dataset.datasetVersion
      },
      providerDisplay: null,
      ui: { locale: 'zh-CN', reducedMotion: false }
    };
    await database.testDatasets.put(datasetRow);
    if (!existingSettings) await database.appSettings.put(settings);
    return { settings, datasetRow };
  });
}
