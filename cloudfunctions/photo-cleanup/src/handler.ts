import type {
  IngredientPhotoCleanupService,
  PhotoCleanupTargetRepository
} from '@fitness/application';

const BATCH_LIMIT = 50;

export interface PhotoCleanupSummary {
  readonly processed: number;
  readonly deleted: number;
  readonly retryScheduled: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface PhotoCleanupLogger {
  info(entry: {
    readonly event: 'photo_cleanup_batch';
    readonly processed: number;
    readonly deleted: number;
    readonly retryScheduled: number;
    readonly skipped: number;
    readonly failed: number;
    readonly latencyMs: number;
    readonly stableErrorCodes: readonly ('storage_unavailable' | 'cleanup_target_failed')[];
  }): void;
}

export interface PhotoCleanupHandlerDependencies {
  readonly targets: PhotoCleanupTargetRepository;
  readonly cleanup: IngredientPhotoCleanupService;
  readonly now: () => string;
  readonly nowMs: () => number;
  readonly logger: PhotoCleanupLogger;
}

export function createPhotoCleanupHandler(dependencies: PhotoCleanupHandlerDependencies) {
  return async (): Promise<PhotoCleanupSummary> => {
    const startedAt = dependencies.nowMs();
    const now = dependencies.now();
    const targets = await dependencies.targets.listDueTargets({ before: now, limit: BATCH_LIMIT });
    let deleted = 0;
    let retryScheduled = 0;
    let skipped = 0;
    let failed = 0;
    const stableErrorCodes = new Set<'storage_unavailable' | 'cleanup_target_failed'>();

    for (const target of targets) {
      try {
        const result = await dependencies.cleanup.cleanupDuePhoto(
          target.userId,
          target.photoId,
          now
        );
        if (result.status === 'deleted') deleted += 1;
        else if (result.status === 'retry_scheduled') {
          retryScheduled += 1;
          stableErrorCodes.add('storage_unavailable');
        } else skipped += 1;
      } catch {
        failed += 1;
        stableErrorCodes.add('cleanup_target_failed');
      }
    }

    const summary: PhotoCleanupSummary = {
      processed: targets.length,
      deleted,
      retryScheduled,
      skipped,
      failed
    };
    dependencies.logger.info({
      event: 'photo_cleanup_batch',
      ...summary,
      latencyMs: Math.max(0, dependencies.nowMs() - startedAt),
      stableErrorCodes: [...stableErrorCodes]
    });
    return summary;
  };
}
