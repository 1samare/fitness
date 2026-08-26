import {
  createLocalBackup,
  deleteLocalAccount,
  restoreLocalBackup
} from '../db/local-data-backup';
import type { FitnessLocalDatabase } from '../db/database';
import type { DataPageRuntime } from './pages/DataPage';

const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;

export interface BrowserDataPageRuntimeOptions {
  readonly database: FitnessLocalDatabase;
  readonly reload?: () => void;
}

export function createBrowserDataPageRuntime(
  options: BrowserDataPageRuntimeOptions
): DataPageRuntime {
  const reload = options.reload ?? (() => {
    window.location.reload();
  });
  return {
    async exportBackup() {
      const backup = await createLocalBackup(options.database);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `fitness-local-backup-${backup.payload.exportedAt.slice(0, 10)}.json`;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    async restoreBackup(file) {
      if (file.size <= 0 || file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error('Local backup file size is invalid');
      }
      const settings = await options.database.appSettings.get('local-default');
      let input: unknown;
      try {
        input = JSON.parse(await file.text());
      } catch {
        throw new Error('Local backup JSON is invalid');
      }
      await restoreLocalBackup(options.database, input, {
        overwrite: true,
        ...(settings?.selectedDataset === null || settings?.selectedDataset === undefined
          ? {}
          : { expectedDataset: settings.selectedDataset })
      });
      reload();
    },

    async deleteAccount() {
      await deleteLocalAccount(options.database);
      sessionStorage.clear();
      localStorage.clear();
      reload();
    }
  };
}
