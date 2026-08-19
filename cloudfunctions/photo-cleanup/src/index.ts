import type { PhotoCleanupSummary } from './handler';
import { createDefaultRuntimePhotoCleanupHandler } from './runtime-handler';

export function createMain(handle: () => Promise<PhotoCleanupSummary>) {
  return (event?: unknown): Promise<PhotoCleanupSummary> => {
    void event;
    return handle();
  };
}

let defaultHandler: (() => Promise<PhotoCleanupSummary>) | undefined;

export const main = createMain(() => {
  defaultHandler ??= createDefaultRuntimePhotoCleanupHandler();
  return defaultHandler();
});
