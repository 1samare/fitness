import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { createBundledLocalTestDataset } from './bundled-test-dataset';
import {
  type AppSettingsRow,
  FitnessLocalDatabase,
  LOCAL_DATABASE_SCHEMA_VERSION,
  LOCAL_USER_ID,
  type TestDatasetRow
} from './database';
import { DexiePlanningRepository } from './dexie-planning-repository';
import {
  LocalBackupChecksumError,
  LocalBackupDatasetMismatchError,
  LocalBackupOverwriteRequiredError
} from './errors';
import {
  createLocalBackup,
  deleteLocalAccount,
  restoreLocalBackup
} from './local-data-backup';

const databases = new Set<FitnessLocalDatabase>();

function createDatabase(): FitnessLocalDatabase {
  const database = new FitnessLocalDatabase(`fitness-backup-test-${crypto.randomUUID()}`);
  databases.add(database);
  return database;
}

afterEach(async () => {
  for (const database of databases) database.close();
  for (const database of databases) await Dexie.delete(database.name);
  databases.clear();
});

async function seedDatabase(database: FitnessLocalDatabase): Promise<{
  readonly settings: AppSettingsRow;
  readonly datasetRow: TestDatasetRow;
}> {
  const dataset = await createBundledLocalTestDataset();
  const selectedDataset = {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.datasetVersion
  };
  const settings: AppSettingsRow = {
    userId: LOCAL_USER_ID,
    schemaVersion: LOCAL_DATABASE_SCHEMA_VERSION,
    updatedAt: '2026-08-26T01:00:00.000Z',
    setupConfirmedAt: '2026-08-26T01:00:00.000Z',
    persistentStorageStatus: 'granted',
    selectedDataset,
    providerDisplay: { baseUrl: 'https://example.invalid/v1', model: 'synthetic-test-model' },
    ui: { locale: 'zh-CN', reducedMotion: false }
  };
  const datasetRow: TestDatasetRow = {
    key: `${dataset.datasetId}@${dataset.datasetVersion}`,
    datasetId: dataset.datasetId,
    datasetVersion: dataset.datasetVersion,
    importedAt: '2026-08-26T01:00:00.000Z',
    dataset
  };
  const repository = new DexiePlanningRepository(database);
  await repository.transact(LOCAL_USER_ID, (current) => ({ nextState: current, result: undefined }));
  await database.transaction('rw', database.appSettings, database.testDatasets, async () => {
    await database.appSettings.put(settings);
    await database.testDatasets.put(datasetRow);
  });
  return { settings, datasetRow };
}

describe('local data backup', () => {
  it('exports and atomically restores the full local state without API keys', async () => {
    const source = createDatabase();
    const seeded = await seedDatabase(source);
    const backup = await createLocalBackup(source);
    expect(backup.format).toBe('fitness-local-backup-v1');
    expect(JSON.stringify(backup)).not.toContain('apiKey');

    const target = createDatabase();
    await restoreLocalBackup(target, backup, {
      overwrite: false,
      expectedDataset: {
        datasetId: seeded.datasetRow.datasetId,
        datasetVersion: seeded.datasetRow.datasetVersion
      }
    });

    expect(await target.appSettings.get(LOCAL_USER_ID)).toEqual(seeded.settings);
    expect(await target.testDatasets.get(seeded.datasetRow.key)).toEqual(seeded.datasetRow);
    expect(await target.planningStates.get(LOCAL_USER_ID)).toEqual(
      await source.planningStates.get(LOCAL_USER_ID)
    );
  });

  it('rejects a tampered checksum without changing the target database', async () => {
    const source = createDatabase();
    await seedDatabase(source);
    const backup = await createLocalBackup(source);
    const planningState = backup.payload.planningState;
    expect(planningState).not.toBeNull();
    const tampered = {
      ...backup,
      payload: {
        ...backup.payload,
        planningState: planningState === null
          ? null
          : { ...planningState, revision: planningState.revision + 1 }
      }
    };
    const target = createDatabase();
    const marker: AppSettingsRow = {
      userId: LOCAL_USER_ID,
      schemaVersion: LOCAL_DATABASE_SCHEMA_VERSION,
      updatedAt: '2026-08-26T02:00:00.000Z',
      setupConfirmedAt: null,
      persistentStorageStatus: 'unknown',
      selectedDataset: null,
      providerDisplay: null,
      ui: { locale: 'zh-CN', reducedMotion: true }
    };
    await target.appSettings.put(marker);

    await expect(restoreLocalBackup(target, tampered, { overwrite: true }))
      .rejects.toBeInstanceOf(LocalBackupChecksumError);
    expect(await target.appSettings.get(LOCAL_USER_ID)).toEqual(marker);
  });

  it('requires explicit overwrite when target data already exists', async () => {
    const source = createDatabase();
    await seedDatabase(source);
    const backup = await createLocalBackup(source);
    const target = createDatabase();
    const backupSettings = backup.payload.appSettings;
    if (!backupSettings) throw new Error('test setup requires backup app settings');
    await target.appSettings.put(backupSettings);

    await expect(restoreLocalBackup(target, backup, { overwrite: false }))
      .rejects.toBeInstanceOf(LocalBackupOverwriteRequiredError);
  });

  it('rejects a backup selected for a different dataset version', async () => {
    const source = createDatabase();
    const seeded = await seedDatabase(source);
    const backup = await createLocalBackup(source);

    await expect(restoreLocalBackup(createDatabase(), backup, {
      overwrite: false,
      expectedDataset: {
        datasetId: seeded.datasetRow.datasetId,
        datasetVersion: 'different-version'
      }
    })).rejects.toBeInstanceOf(LocalBackupDatasetMismatchError);
  });

  it('rolls back cleared target data when a restore write fails', async () => {
    const source = createDatabase();
    await seedDatabase(source);
    const backup = await createLocalBackup(source);
    const target = createDatabase();
    const marker: AppSettingsRow = {
      userId: LOCAL_USER_ID,
      schemaVersion: LOCAL_DATABASE_SCHEMA_VERSION,
      updatedAt: '2026-08-26T04:00:00.000Z',
      setupConfirmedAt: null,
      persistentStorageStatus: 'unknown',
      selectedDataset: null,
      providerDisplay: null,
      ui: { locale: 'zh-CN', reducedMotion: true }
    };
    await target.appSettings.put(marker);
    target.planningStates.hook('creating', () => {
      throw new Error('restore-write-failed');
    });

    await expect(restoreLocalBackup(target, backup, { overwrite: true }))
      .rejects.toThrow('restore-write-failed');
    expect(await target.appSettings.get(LOCAL_USER_ID)).toEqual(marker);
    expect(await target.planningStates.count()).toBe(0);
    expect(await target.testDatasets.count()).toBe(0);
  });

  it('clears planning state, settings, and datasets as one local account deletion', async () => {
    const database = createDatabase();
    await seedDatabase(database);

    await deleteLocalAccount(database);

    expect(await database.planningStates.count()).toBe(0);
    expect(await database.appSettings.count()).toBe(0);
    expect(await database.testDatasets.count()).toBe(0);
  });
});
