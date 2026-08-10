import { nutritionDataSnapshotSchema } from '@fitness/contracts';
import type { NutritionDataSnapshot, NutritionProvider } from '@fitness/domain';
import { assertUniqueRecordIds } from './reviewed-records';

export class InvalidNutritionSnapshotError extends Error {
  public readonly code = 'invalid_nutrition_snapshot' as const;

  public constructor() {
    super('Nutrition snapshot failed runtime validation');
    this.name = 'InvalidNutritionSnapshotError';
  }
}

export class NutritionSnapshotUnavailableError extends Error {
  public readonly code = 'nutrition_snapshot_unavailable' as const;

  public constructor(public readonly snapshotId: string) {
    super(`No approved nutrition snapshot is available for ${snapshotId}`);
    this.name = 'NutritionSnapshotUnavailableError';
  }
}

export interface ReviewedNutritionCacheOptions {
  readonly mode: 'production' | 'test';
  readonly snapshots: readonly unknown[];
}

export class ReviewedNutritionCache implements NutritionProvider {
  private readonly mode: ReviewedNutritionCacheOptions['mode'];
  private readonly snapshots: ReadonlyMap<string, NutritionDataSnapshot>;

  public constructor(options: ReviewedNutritionCacheOptions) {
    const snapshots: NutritionDataSnapshot[] = [];
    for (const value of options.snapshots) {
      const parsed = nutritionDataSnapshotSchema.safeParse(value);
      if (!parsed.success) throw new InvalidNutritionSnapshotError();
      snapshots.push(parsed.data);
    }
    assertUniqueRecordIds(snapshots);
    this.mode = options.mode;
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  }

  public getSnapshot(snapshotId: string): Promise<NutritionDataSnapshot> {
    const snapshot = this.snapshots.get(snapshotId);
    if (
      snapshot === undefined
      || (this.mode === 'production' && snapshot.qualityStatus !== 'reviewed')
    ) {
      return Promise.reject(new NutritionSnapshotUnavailableError(snapshotId));
    }
    return Promise.resolve(structuredClone(snapshot));
  }
}
