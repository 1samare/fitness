import { describe, expect, test, vi } from 'vitest';
import type { PrivatePhotoStorage } from '@fitness/domain';
import type {
  CloudBaseDatabase,
  CloudBaseDocumentReference,
  CloudBasePhotoCleanupQueryDatabase,
  CloudBaseTransaction
} from '@fitness/persistence';
import { createMain } from './index';
import {
  createCloudBaseRuntimePrivatePhotoStorage,
  createRuntimePhotoCleanupHandler
} from './runtime-handler';

class EmptyDocumentReference implements CloudBaseDocumentReference {
  public get(): Promise<{ readonly data?: unknown }> { return Promise.resolve({}); }
  public set(): Promise<unknown> { return Promise.resolve({ updated: 1 }); }
}

class EmptyDatabase implements CloudBaseDatabase, CloudBaseTransaction, CloudBasePhotoCleanupQueryDatabase {
  public readonly command = { lte: (value: string) => ({ operator: 'lte', value }) };

  public collection() {
    return {
      doc: () => new EmptyDocumentReference(),
      where: () => {
        const query = {
          orderBy: () => query,
          skip: () => query,
          limit: () => query,
          get: () => Promise.resolve({ data: [] })
        };
        return query;
      }
    };
  }

  public runTransaction<TResult>(operation: (transaction: CloudBaseTransaction) => Promise<TResult>) {
    return operation(this);
  }
}

const storage: PrivatePhotoStorage = {
  inspectPrivateFile: () => Promise.reject(new Error('not used')),
  deletePrivateFile: () => Promise.resolve('deleted')
};

describe('photo cleanup runtime', () => {
  test('passes the default CloudBase client numeric delete DTO through the storage boundary', async () => {
    const storage = createCloudBaseRuntimePrivatePhotoStorage({
      downloadFile: vi.fn(),
      deleteFile: vi.fn().mockResolvedValue({
        errMsg: 'deleteFile:ok',
        fileList: [{ fileID: 'cloud://env.bucket/photo.jpg', status: 0, errMsg: 'ok' }]
      })
    });

    await expect(storage.deletePrivateFile({
      privateFileId: 'cloud://env.bucket/photo.jpg'
    })).resolves.toBe('deleted');
  });

  test('composes CloudBase persistence and storage boundaries without scanning when nothing is due', async () => {
    const logs: unknown[] = [];
    const handler = createRuntimePhotoCleanupHandler({
      database: new EmptyDatabase(),
      storage,
      now: () => '2026-08-19T23:00:00.000Z',
      nowMs: () => 100,
      nextId: (prefix) => `${prefix}-1`,
      logger: { info: (entry) => logs.push(entry) }
    });

    await expect(handler()).resolves.toEqual({
      processed: 0,
      deleted: 0,
      retryScheduled: 0,
      skipped: 0,
      failed: 0
    });
    expect(logs).toHaveLength(1);
  });

  test('does not forward caller-selected target identities to the scheduled handler', async () => {
    const handle = vi.fn(() => Promise.resolve({
      processed: 0, deleted: 0, retryScheduled: 0, skipped: 0, failed: 0
    }));
    const main = createMain(handle);

    await main({
      userId: 'attacker-selected-user',
      photoId: 'attacker-selected-photo',
      targets: [{ userId: 'attacker-selected-user', photoId: 'attacker-selected-photo' }]
    });

    expect(handle).toHaveBeenCalledWith();
  });
});
