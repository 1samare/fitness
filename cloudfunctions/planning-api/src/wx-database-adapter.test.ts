import { describe, expect, test } from 'vitest';
import { adaptWxCloudBaseDatabase } from './wx-database-adapter';

describe('adaptWxCloudBaseDatabase', () => {
  test('adapts promise-based document and transaction operations', async () => {
    const documents = new Map<string, unknown>();
    const rawDatabase = {
      collection(name: string) {
        return {
          doc(id: string) {
            const key = `${name}/${id}`;
            return {
              get: () => Promise.resolve(
                documents.has(key) ? { data: documents.get(key) } : {}
              ),
              set: (input: { data: unknown }) => {
                documents.set(key, input.data);
                return Promise.resolve({ updated: 1 });
              }
            };
          }
        };
      },
      runTransaction(operation: (transaction: unknown) => Promise<unknown>) {
        return operation(this);
      }
    };

    const database = adaptWxCloudBaseDatabase(rawDatabase);
    const result = await database.runTransaction(async (transaction) => {
      const reference = transaction.collection('states').doc('user-a');
      await reference.set({ data: { value: 1 } });
      return reference.get();
    });

    expect(result).toEqual({ data: { value: 1 } });
  });

  test('rejects callback-style or malformed SDK results', async () => {
    const database = adaptWxCloudBaseDatabase({
      collection: () => ({
        doc: () => ({
          get: () => 'callback-request-id',
          set: () => Promise.resolve({})
        })
      }),
      runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => operation({
        collection: () => ({
          doc: () => ({
            get: () => 'callback-request-id',
            set: () => Promise.resolve({})
          })
        })
      })
    });

    await expect(database.collection('states').doc('user-a').get()).rejects.toThrow(
      'CloudBase SDK did not return a Promise'
    );
  });
});
