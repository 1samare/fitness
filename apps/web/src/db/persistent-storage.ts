export type PersistentStorageStatus = 'granted' | 'denied' | 'unsupported';

export interface StoragePersistenceAdapter {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

export async function requestPersistentStorage(
  storage: StoragePersistenceAdapter | undefined
): Promise<PersistentStorageStatus> {
  if (!storage) return 'unsupported';
  try {
    if (await storage.persisted()) return 'granted';
    return await storage.persist() ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
