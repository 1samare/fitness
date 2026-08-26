import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it, vi } from 'vitest';
import { FitnessLocalDatabase } from './database';
import type { LocalDatabaseUpgradeBlockedError } from './errors';

function openBlockingVersionOneDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('planningStates', { keyPath: 'userId' });
      request.result.createObjectStore('appSettings', { keyPath: 'userId' });
      request.result.createObjectStore('testDatasets', { keyPath: 'key' });
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => undefined;
      resolve(request.result);
    };
  });
}

class VersionTwoFitnessLocalDatabase extends FitnessLocalDatabase {
  public constructor(name: string, onBlocked: (error: LocalDatabaseUpgradeBlockedError) => void) {
    super(name, { onUpgradeBlocked: onBlocked });
    this.version(2).stores({
      planningStates: 'userId, revision, updatedAt',
      appSettings: 'userId, updatedAt',
      testDatasets: 'key, datasetId, datasetVersion, importedAt'
    });
  }
}

describe('FitnessLocalDatabase upgrade handling', () => {
  it('reports a stable error code when another tab blocks a schema upgrade', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const name = `fitness-upgrade-test-${crypto.randomUUID()}`;
    const first = await openBlockingVersionOneDatabase(name);
    let resolveBlocked: ((error: LocalDatabaseUpgradeBlockedError) => void) | undefined;
    const blocked = new Promise<LocalDatabaseUpgradeBlockedError>((resolve) => {
      resolveBlocked = resolve;
    });
    const second = new VersionTwoFitnessLocalDatabase(name, (error) => {
      resolveBlocked?.(error);
    });
    const opening = second.open();

    await expect(blocked).resolves.toMatchObject({ code: 'local_database_upgrade_blocked' });
    first.close();
    await opening;
    second.close();
    await Dexie.delete(name);
    warning.mockRestore();
  });
});
