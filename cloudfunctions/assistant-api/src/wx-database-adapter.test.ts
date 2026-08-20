import { describe, expect, test } from 'vitest';
import { adaptWxCloudBaseDatabase } from './wx-database-adapter';

describe('adaptWxCloudBaseDatabase', () => {
  test('forwards promise-based document removal', async () => {
    const remove = () => Promise.resolve({ deleted: 1 });
    const createDocument = () => ({
      get: () => Promise.resolve({ data: { value: 1 } }),
      set: () => Promise.resolve({ updated: 1 }),
      remove
    });
    const createTransaction = () => ({
      collection: () => ({ doc: createDocument })
    });
    const rawDatabase = {
      ...createTransaction(),
      runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => (
        operation(createTransaction())
      )
    };
    const database = adaptWxCloudBaseDatabase(rawDatabase);
    const reference = database.collection('states').doc('user-a') as unknown as {
      remove(): Promise<unknown>;
    };

    await expect(reference.remove()).resolves.toEqual({ deleted: 1 });
  });
});
