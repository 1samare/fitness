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
              },
              remove: () => {
                documents.delete(key);
                return Promise.resolve({ deleted: 1 });
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

  test('forwards promise-based document removal', async () => {
    const remove = () => Promise.resolve({ deleted: 1 });
    const database = adaptWxCloudBaseDatabase({
      collection: () => ({
        doc: () => ({
          get: () => Promise.resolve({ data: { value: 1 } }),
          set: () => Promise.resolve({}),
          remove
        })
      }),
      runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => operation({
        collection: () => ({
          doc: () => ({
            get: () => Promise.resolve({ data: { value: 1 } }),
            set: () => Promise.resolve({}),
            remove
          })
        })
      })
    });
    const reference = database.collection('states').doc('user-a') as unknown as {
      remove(): Promise<unknown>;
    };

    await expect(reference.remove()).resolves.toEqual({ deleted: 1 });
  });

  test('rejects callback-style or malformed SDK results', async () => {
    const database = adaptWxCloudBaseDatabase({
      collection: () => ({
        doc: () => ({
          get: () => 'callback-request-id',
          set: () => Promise.resolve({}),
          remove: () => Promise.resolve({})
        })
      }),
      runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => operation({
        collection: () => ({
          doc: () => ({
            get: () => 'callback-request-id',
            set: () => Promise.resolve({}),
            remove: () => Promise.resolve({})
          })
        })
      })
    });

    await expect(database.collection('states').doc('user-a').get()).rejects.toThrow(
      'CloudBase SDK did not return a Promise'
    );
  });

  test('maps the wx-server-sdk missing-document error to an empty result', async () => {
    const notFound = Object.assign(
      new Error('document.get:fail document with _id user-a does not exist'),
      {
        errCode: -1,
        errMsg: 'document.get:fail document with _id user-a does not exist'
      }
    );
    const database = adaptWxCloudBaseDatabase({
      collection: () => ({
        doc: () => ({
          get: () => Promise.reject(notFound),
          set: () => Promise.resolve({}),
          remove: () => Promise.resolve({})
        })
      }),
      runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => operation({
        collection: () => ({
          doc: () => ({
            get: () => Promise.reject(notFound),
            set: () => Promise.resolve({}),
            remove: () => Promise.resolve({})
          })
        })
      })
    });

    await expect(database.collection('states').doc('user-a').get()).resolves.toEqual({});
  });

  test('maps a null CloudBase document to an empty result', async () => {
    const database = adaptWxCloudBaseDatabase({
      collection: () => ({
        doc: () => ({
          get: () => Promise.resolve({ data: null }),
          set: () => Promise.resolve({}),
          remove: () => Promise.resolve({})
        })
      }),
      runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => operation({
        collection: () => ({
          doc: () => ({
            get: () => Promise.resolve({ data: null }),
            set: () => Promise.resolve({}),
            remove: () => Promise.resolve({})
          })
        })
      })
    });

    await expect(database.collection('states').doc('user-a').get()).resolves.toEqual({});
  });
});
