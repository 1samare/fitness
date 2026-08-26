import { describe, expect, it } from 'vitest';
import { requestPersistentStorage } from './persistent-storage';

describe('requestPersistentStorage', () => {
  it('returns unsupported when the StorageManager API is unavailable', async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toBe('unsupported');
  });

  it('does not prompt again when storage is already persisted', async () => {
    let persistCalls = 0;
    const storage = {
      persisted: () => Promise.resolve(true),
      persist: () => {
        persistCalls += 1;
        return Promise.resolve(true);
      }
    };

    await expect(requestPersistentStorage(storage)).resolves.toBe('granted');
    expect(persistCalls).toBe(0);
  });

  it('reports denied when the browser rejects persistence', async () => {
    const storage = {
      persisted: () => Promise.resolve(false),
      persist: () => Promise.resolve(false)
    };

    await expect(requestPersistentStorage(storage)).resolves.toBe('denied');
  });
});
