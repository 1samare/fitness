import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { FitnessLocalDatabase, LOCAL_USER_ID } from './database';
import { initializeLocalData } from './initialize-local-data';

const databases = new Set<FitnessLocalDatabase>();

afterEach(async () => {
  for (const database of databases) database.close();
  for (const database of databases) await Dexie.delete(database.name);
  databases.clear();
});

describe('initializeLocalData', () => {
  it('installs the bundled test dataset and default settings into an empty database', async () => {
    const database = new FitnessLocalDatabase(`fitness-init-test-${crypto.randomUUID()}`);
    databases.add(database);

    const result = await initializeLocalData(database, '2026-08-26T03:00:00.000Z');

    expect(await database.testDatasets.get(result.datasetRow.key)).toEqual(result.datasetRow);
    expect(await database.appSettings.get(LOCAL_USER_ID)).toEqual(result.settings);
    expect(result.settings.selectedDataset).toEqual({
      datasetId: result.datasetRow.datasetId,
      datasetVersion: result.datasetRow.datasetVersion
    });
  });

  it('keeps existing user settings when initialization is repeated', async () => {
    const database = new FitnessLocalDatabase(`fitness-init-test-${crypto.randomUUID()}`);
    databases.add(database);
    const first = await initializeLocalData(database, '2026-08-26T03:00:00.000Z');
    const changed = {
      ...first.settings,
      updatedAt: '2026-08-26T03:30:00.000Z',
      ui: { ...first.settings.ui, reducedMotion: true }
    };
    await database.appSettings.put(changed);

    const second = await initializeLocalData(database, '2026-08-26T04:00:00.000Z');

    expect(second.settings).toEqual(changed);
    expect(await database.testDatasets.count()).toBe(1);
  });
});
