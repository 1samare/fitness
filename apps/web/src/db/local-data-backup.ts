import {
  assertPlanningAggregateCapacityTransition
} from '@fitness/application/browser';
import { localTestPlanningDatasetV1Schema } from '@fitness/contracts';
import {
  InMemoryPlanningRepository,
  parseAndAssertPlanningState
} from '@fitness/persistence/browser';
import { z } from 'zod';
import { sha256HexOfJson } from '../utils/sha256';
import {
  localTestDatasetChecksumPayload
} from './bundled-test-dataset';
import type {
  AppSettingsRow,
  FitnessLocalDatabase,
  PlanningStateRow,
  TestDatasetRow
} from './database';
import {
  LOCAL_DATABASE_SCHEMA_VERSION,
  LOCAL_USER_ID
} from './database';
import {
  LocalBackupChecksumError,
  LocalBackupDatasetMismatchError,
  LocalBackupOverwriteRequiredError,
  LocalBackupValidationError
} from './errors';

export const LOCAL_BACKUP_FORMAT = 'fitness-local-backup-v1';

export interface LocalBackupPayload {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly userId: 'local-default';
  readonly planningState: PlanningStateRow | null;
  readonly appSettings: AppSettingsRow | null;
  readonly testDatasets: readonly TestDatasetRow[];
}

export interface LocalBackupEnvelope {
  readonly format: typeof LOCAL_BACKUP_FORMAT;
  readonly checksumSha256: string;
  readonly payload: LocalBackupPayload;
}

export interface RestoreLocalBackupOptions {
  readonly overwrite: boolean;
  readonly expectedDataset?: {
    readonly datasetId: string;
    readonly datasetVersion: string;
  };
}

const datasetReferenceSchema = z.object({
  datasetId: z.string().trim().min(1),
  datasetVersion: z.string().trim().min(1)
}).strict();

const appSettingsSchema = z.object({
  userId: z.literal(LOCAL_USER_ID),
  schemaVersion: z.literal(LOCAL_DATABASE_SCHEMA_VERSION),
  updatedAt: z.iso.datetime(),
  setupConfirmedAt: z.iso.datetime().nullable(),
  persistentStorageStatus: z.enum(['unknown', 'granted', 'denied', 'unsupported']),
  selectedDataset: datasetReferenceSchema.nullable(),
  providerDisplay: z.object({
    baseUrl: z.url(),
    model: z.string().trim().min(1)
  }).strict().nullable(),
  ui: z.object({
    locale: z.literal('zh-CN'),
    reducedMotion: z.boolean()
  }).strict()
}).strict();

const planningStateRowSchema = z.object({
  userId: z.literal(LOCAL_USER_ID),
  schemaVersion: z.literal(LOCAL_DATABASE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  state: z.unknown()
}).strict();

const testDatasetRowSchema = z.object({
  key: z.string().trim().min(1),
  datasetId: z.string().trim().min(1),
  datasetVersion: z.string().trim().min(1),
  importedAt: z.iso.datetime(),
  dataset: localTestPlanningDatasetV1Schema
}).strict();

const backupEnvelopeSchema = z.object({
  format: z.literal(LOCAL_BACKUP_FORMAT),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  payload: z.object({
    schemaVersion: z.literal(1),
    exportedAt: z.iso.datetime(),
    userId: z.literal(LOCAL_USER_ID),
    planningState: planningStateRowSchema.nullable(),
    appSettings: appSettingsSchema.nullable(),
    testDatasets: z.array(testDatasetRowSchema).max(100)
  }).strict()
}).strict();

function backupChecksumPayload(payload: LocalBackupPayload): {
  readonly format: typeof LOCAL_BACKUP_FORMAT;
  readonly payload: LocalBackupPayload;
} {
  return { format: LOCAL_BACKUP_FORMAT, payload };
}

function datasetMatches(
  left: { readonly datasetId: string; readonly datasetVersion: string },
  right: { readonly datasetId: string; readonly datasetVersion: string }
): boolean {
  return left.datasetId === right.datasetId && left.datasetVersion === right.datasetVersion;
}

async function validateBackup(input: unknown): Promise<LocalBackupEnvelope> {
  let parsed: z.infer<typeof backupEnvelopeSchema>;
  try {
    parsed = backupEnvelopeSchema.parse(input);
  } catch {
    throw new LocalBackupValidationError();
  }
  const expectedChecksum = await sha256HexOfJson({
    format: parsed.format,
    payload: parsed.payload
  });
  if (expectedChecksum !== parsed.checksumSha256) throw new LocalBackupChecksumError();

  const planningState: PlanningStateRow | null = parsed.payload.planningState === null
    ? null
    : {
        ...parsed.payload.planningState,
        state: parseAndAssertPlanningState(parsed.payload.planningState.state, LOCAL_USER_ID)
      };
  const testDatasets: TestDatasetRow[] = [];
  for (const row of parsed.payload.testDatasets) {
    const expectedKey = `${row.datasetId}@${row.datasetVersion}`;
    if (row.key !== expectedKey
      || row.dataset.datasetId !== row.datasetId
      || row.dataset.datasetVersion !== row.datasetVersion) {
      throw new LocalBackupDatasetMismatchError();
    }
    const datasetChecksum = await sha256HexOfJson(localTestDatasetChecksumPayload(row.dataset));
    if (datasetChecksum !== row.dataset.checksumSha256) {
      throw new LocalBackupValidationError('Local test dataset checksum does not match');
    }
    testDatasets.push(row);
  }
  const selectedDataset = parsed.payload.appSettings?.selectedDataset;
  if (selectedDataset && !testDatasets.some((row) => datasetMatches(row, selectedDataset))) {
    throw new LocalBackupDatasetMismatchError();
  }
  if (planningState) {
    const emptyState = await new InMemoryPlanningRepository().read(LOCAL_USER_ID);
    assertPlanningAggregateCapacityTransition(emptyState, planningState.state);
  }
  return {
    format: parsed.format,
    checksumSha256: parsed.checksumSha256,
    payload: {
      ...parsed.payload,
      planningState,
      appSettings: parsed.payload.appSettings,
      testDatasets
    }
  };
}

export async function createLocalBackup(
  database: FitnessLocalDatabase
): Promise<LocalBackupEnvelope> {
  const snapshot = await database.transaction(
    'r',
    database.planningStates,
    database.appSettings,
    database.testDatasets,
    async () => Promise.all([
      database.planningStates.get(LOCAL_USER_ID),
      database.appSettings.get(LOCAL_USER_ID),
      database.testDatasets.toArray()
    ])
  );
  const planningState = snapshot[0] ?? null;
  const appSettings = snapshot[1] ?? null;
  const testDatasets = snapshot[2];
  const payload: LocalBackupPayload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    userId: LOCAL_USER_ID,
    planningState,
    appSettings,
    testDatasets
  };
  const candidate = {
    format: LOCAL_BACKUP_FORMAT,
    checksumSha256: await sha256HexOfJson(backupChecksumPayload(payload)),
    payload
  } satisfies LocalBackupEnvelope;
  return validateBackup(candidate);
}

export async function restoreLocalBackup(
  database: FitnessLocalDatabase,
  input: unknown,
  options: RestoreLocalBackupOptions
): Promise<void> {
  const backup = await validateBackup(input);
  const selectedDataset = backup.payload.appSettings?.selectedDataset;
  if (options.expectedDataset
    && (!selectedDataset || !datasetMatches(selectedDataset, options.expectedDataset))) {
    throw new LocalBackupDatasetMismatchError();
  }
  await database.transaction(
    'rw',
    database.planningStates,
    database.appSettings,
    database.testDatasets,
    async () => {
      const counts = await Promise.all([
        database.planningStates.count(),
        database.appSettings.count(),
        database.testDatasets.count()
      ]);
      if (!options.overwrite && counts.some((count) => count > 0)) {
        throw new LocalBackupOverwriteRequiredError();
      }
      await Promise.all([
        database.planningStates.clear(),
        database.appSettings.clear(),
        database.testDatasets.clear()
      ]);
      if (backup.payload.planningState) {
        await database.planningStates.put(backup.payload.planningState);
      }
      if (backup.payload.appSettings) {
        await database.appSettings.put(backup.payload.appSettings);
      }
      if (backup.payload.testDatasets.length > 0) {
        await database.testDatasets.bulkPut([...backup.payload.testDatasets]);
      }
    }
  );
}

export async function deleteLocalAccount(database: FitnessLocalDatabase): Promise<void> {
  await database.transaction(
    'rw',
    database.planningStates,
    database.appSettings,
    database.testDatasets,
    async () => {
      await Promise.all([
        database.planningStates.clear(),
        database.appSettings.clear(),
        database.testDatasets.clear()
      ]);
    }
  );
}
