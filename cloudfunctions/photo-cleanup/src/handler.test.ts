import { describe, expect, test, vi } from 'vitest';
import { createPhotoCleanupHandler } from './handler';

const now = '2026-08-19T23:00:00.000Z';

describe('photo cleanup handler', () => {
  test('processes one bounded batch sequentially and returns counts only', async () => {
    const active: string[] = [];
    let maximumConcurrency = 0;
    const logs: unknown[] = [];
    const handler = createPhotoCleanupHandler({
      targets: {
        listDueTargets: vi.fn(() => Promise.resolve([
          { userId: 'private-user-a', photoId: 'private-photo-a' },
          { userId: 'private-user-b', photoId: 'private-photo-b' },
          { userId: 'private-user-c', photoId: 'private-photo-c' }
        ]))
      },
      cleanup: {
        cleanupDuePhoto: vi.fn(async (_userId: string, photoId: string) => {
          active.push(photoId);
          maximumConcurrency = Math.max(maximumConcurrency, active.length);
          await Promise.resolve();
          active.pop();
          if (photoId.endsWith('a')) return { status: 'deleted' as const };
          if (photoId.endsWith('b')) {
            return {
              status: 'retry_scheduled' as const,
              retryAt: '2026-08-19T23:15:00.000Z'
            };
          }
          return { status: 'skipped' as const };
        })
      },
      now: () => now,
      nowMs: (() => {
        let value = 100;
        return () => value += 5;
      })(),
      logger: { info: (entry) => logs.push(entry) }
    });

    await expect(handler()).resolves.toEqual({
      processed: 3,
      deleted: 1,
      retryScheduled: 1,
      skipped: 1,
      failed: 0
    });
    expect(maximumConcurrency).toBe(1);
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('private-photo');
    expect(serialized).not.toContain('cloud://');
    expect(serialized).toContain('storage_unavailable');
  });

  test('isolates an unexpected per-target failure and logs only a stable code', async () => {
    const logs: unknown[] = [];
    const cleanupDuePhoto = vi.fn()
      .mockRejectedValueOnce(new Error('cloud://secret raw-delete-error private-user-a'))
      .mockResolvedValueOnce({ status: 'deleted' as const });
    const handler = createPhotoCleanupHandler({
      targets: {
        listDueTargets: () => Promise.resolve([
          { userId: 'private-user-a', photoId: 'private-photo-a' },
          { userId: 'private-user-b', photoId: 'private-photo-b' }
        ])
      },
      cleanup: { cleanupDuePhoto },
      now: () => now,
      nowMs: () => 100,
      logger: { info: (entry) => logs.push(entry) }
    });

    await expect(handler()).resolves.toEqual({
      processed: 2,
      deleted: 1,
      retryScheduled: 0,
      skipped: 0,
      failed: 1
    });
    expect(cleanupDuePhoto).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs)).toContain('cleanup_target_failed');
    expect(JSON.stringify(logs)).not.toContain('raw-delete-error');
    expect(JSON.stringify(logs)).not.toContain('private-user');
  });
});
