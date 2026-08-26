import type { PlanningRepository } from '@fitness/application/browser';
import type { LocalTestPlanningDatasetV1 } from '@fitness/contracts';
import Dexie, { type EntityTable } from 'dexie';
import { LocalDatabaseUpgradeBlockedError } from './errors';

type PlanningAggregateState = Awaited<ReturnType<PlanningRepository['read']>>;

export const LOCAL_DATABASE_NAME = 'fitness_local_v1';
export const LOCAL_USER_ID = 'local-default';
export const LOCAL_DATABASE_SCHEMA_VERSION = 1;

export interface PlanningStateRow {
  readonly userId: typeof LOCAL_USER_ID;
  readonly schemaVersion: typeof LOCAL_DATABASE_SCHEMA_VERSION;
  readonly revision: number;
  readonly updatedAt: string;
  readonly state: PlanningAggregateState;
}

export interface AppSettingsRow {
  readonly userId: typeof LOCAL_USER_ID;
  readonly schemaVersion: typeof LOCAL_DATABASE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly setupConfirmedAt: string | null;
  readonly persistentStorageStatus: 'unknown' | 'granted' | 'denied' | 'unsupported';
  readonly selectedDataset: { readonly datasetId: string; readonly datasetVersion: string } | null;
  readonly providerDisplay: { readonly baseUrl: string; readonly model: string } | null;
  readonly ui: { readonly locale: 'zh-CN'; readonly reducedMotion: boolean };
}

export interface TestDatasetRow {
  readonly key: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly importedAt: string;
  readonly dataset: LocalTestPlanningDatasetV1;
}

export interface FitnessLocalDatabaseOptions {
  readonly onUpgradeBlocked?: (error: LocalDatabaseUpgradeBlockedError) => void;
}

export class FitnessLocalDatabase extends Dexie {
  public readonly planningStates!: EntityTable<PlanningStateRow, 'userId'>;
  public readonly appSettings!: EntityTable<AppSettingsRow, 'userId'>;
  public readonly testDatasets!: EntityTable<TestDatasetRow, 'key'>;

  public constructor(name = LOCAL_DATABASE_NAME, options: FitnessLocalDatabaseOptions = {}) {
    super(name);
    this.version(LOCAL_DATABASE_SCHEMA_VERSION).stores({
      planningStates: 'userId, revision, updatedAt',
      appSettings: 'userId, updatedAt',
      testDatasets: 'key, datasetId, datasetVersion, importedAt'
    });
    this.on('blocked', () => {
      options.onUpgradeBlocked?.(new LocalDatabaseUpgradeBlockedError(name));
    });
  }
}
