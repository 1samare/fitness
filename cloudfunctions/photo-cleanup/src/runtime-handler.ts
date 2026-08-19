import { randomUUID } from 'node:crypto';
import * as cloud from 'wx-server-sdk';
import { createIngredientPhotoCleanupService } from '@fitness/application';
import type { PrivatePhotoStorage } from '@fitness/domain';
import {
  CloudBasePhotoCleanupTargetRepository,
  CloudBasePlanningRepository,
  type CloudBaseDatabase,
  type CloudBaseDocumentReference,
  type CloudBasePhotoCleanupQueryDatabase,
  type CloudBaseTransaction
} from '@fitness/persistence';
import {
  CloudBasePrivatePhotoStorage,
  type CloudBasePrivateFileClient
} from '@fitness/providers';
import {
  createPhotoCleanupHandler,
  type PhotoCleanupLogger,
  type PhotoCleanupSummary
} from './handler';

export interface RuntimePhotoCleanupOptions {
  readonly database: CloudBaseDatabase & CloudBasePhotoCleanupQueryDatabase;
  readonly storage: PrivatePhotoStorage;
  readonly now?: (() => string) | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
  readonly logger: PhotoCleanupLogger;
}

interface RawDocumentReference {
  get(): unknown;
  set(input: { readonly data: unknown }): unknown;
}

interface RawCollection {
  doc(id: string): unknown;
  where(filter: Readonly<Record<string, unknown>>): unknown;
}

interface RawTransactionCollection {
  doc(id: string): unknown;
}

interface RawQuery {
  limit(value: number): unknown;
}

interface RawLimitedQuery {
  get(): unknown;
}

interface RawTransaction {
  collection(name: string): unknown;
}

interface RawDatabase extends RawTransaction {
  readonly command: { lte(value: string): unknown };
  runTransaction(operation: (transaction: unknown) => Promise<unknown>): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePromise(value: unknown): Promise<unknown> {
  if (!(value instanceof Promise)) {
    return Promise.reject(new Error('CloudBase SDK did not return a Promise'));
  }
  return value;
}

function isRawDocumentReference(value: unknown): value is RawDocumentReference {
  return isRecord(value) && typeof value.get === 'function' && typeof value.set === 'function';
}

function isRawCollection(value: unknown): value is RawCollection {
  return isRecord(value)
    && typeof value.doc === 'function'
    && typeof value.where === 'function';
}

function isRawTransactionCollection(value: unknown): value is RawTransactionCollection {
  return isRecord(value) && typeof value.doc === 'function';
}

function isRawQuery(value: unknown): value is RawQuery {
  return isRecord(value) && typeof value.limit === 'function';
}

function isRawLimitedQuery(value: unknown): value is RawLimitedQuery {
  return isRecord(value) && typeof value.get === 'function';
}

function isRawTransaction(value: unknown): value is RawTransaction {
  return isRecord(value) && typeof value.collection === 'function';
}

function isRawDatabase(value: unknown): value is RawDatabase {
  return isRecord(value)
    && typeof value.collection === 'function'
    && typeof value.runTransaction === 'function'
    && isRecord(value.command)
    && typeof value.command.lte === 'function';
}

function isMissingDocumentError(value: unknown): boolean {
  return isRecord(value)
    && value.errCode === -1
    && typeof value.errMsg === 'string'
    && value.errMsg.startsWith('document.get:fail document with _id ')
    && value.errMsg.endsWith(' does not exist');
}

function adaptDocumentReference(value: unknown): CloudBaseDocumentReference {
  if (!isRawDocumentReference(value)) throw new Error('CloudBase SDK returned an invalid document');
  return {
    async get() {
      try {
        const result = await requirePromise(value.get());
        if (!isRecord(result)) throw new Error('CloudBase SDK returned an invalid get result');
        return result.data === undefined || result.data === null ? {} : { data: result.data };
      } catch (error: unknown) {
        if (isMissingDocumentError(error)) return {};
        throw error;
      }
    },
    set: (input) => requirePromise(value.set(input))
  };
}

function adaptTransaction(value: unknown): CloudBaseTransaction {
  if (!isRawTransaction(value)) throw new Error('CloudBase SDK returned an invalid transaction');
  return {
    collection(name) {
      const collection = value.collection(name);
      if (!isRawTransactionCollection(collection)) {
        throw new Error('CloudBase SDK returned an invalid transaction collection');
      }
      return { doc: (id) => adaptDocumentReference(collection.doc(id)) };
    }
  };
}

export function adaptPhotoCleanupDatabase(
  value: unknown
): CloudBaseDatabase & CloudBasePhotoCleanupQueryDatabase {
  if (!isRawDatabase(value)) throw new Error('CloudBase SDK returned an invalid database');
  return {
    command: { lte: (before) => value.command.lte(before) },
    collection(name) {
      const rawCollection = value.collection(name);
      if (!isRawCollection(rawCollection)) {
        throw new Error('CloudBase SDK returned an invalid collection');
      }
      return {
        doc: (id) => adaptDocumentReference(rawCollection.doc(id)),
        where(filter) {
          const rawQuery = rawCollection.where(filter);
          if (!isRawQuery(rawQuery)) throw new Error('CloudBase SDK returned an invalid query');
          return {
            limit(limit) {
              const rawLimited = rawQuery.limit(limit);
              if (!isRawLimitedQuery(rawLimited)) {
                throw new Error('CloudBase SDK returned an invalid limited query');
              }
              return {
                async get() {
                  const result = await requirePromise(rawLimited.get());
                  if (!isRecord(result)) throw new Error('CloudBase SDK returned an invalid query result');
                  return result.data === undefined ? {} : { data: result.data };
                }
              };
            }
          };
        }
      };
    },
    async runTransaction<TResult>(
      operation: (transaction: CloudBaseTransaction) => Promise<TResult>
    ): Promise<TResult> {
      let callbackResult: { readonly value: TResult } | undefined;
      const rawResult = value.runTransaction(async (rawTransaction) => {
        const result = await operation(adaptTransaction(rawTransaction));
        callbackResult = { value: result };
        return result;
      });
      await requirePromise(rawResult);
      if (callbackResult === undefined) {
        throw new Error('CloudBase transaction completed without a callback result');
      }
      return callbackResult.value;
    }
  };
}

export function createRuntimePhotoCleanupHandler(options: RuntimePhotoCleanupOptions) {
  const repository = new CloudBasePlanningRepository(options.database);
  const targets = new CloudBasePhotoCleanupTargetRepository(options.database);
  const cleanup = createIngredientPhotoCleanupService({
    repository,
    storage: options.storage,
    nextId: options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  });
  return createPhotoCleanupHandler({
    targets,
    cleanup,
    now: options.now ?? (() => new Date().toISOString()),
    nowMs: options.nowMs ?? (() => Date.now()),
    logger: options.logger
  });
}

function defaultCloudClient(): CloudBasePrivateFileClient {
  return {
    downloadFile: (input) => cloud.downloadFile(input),
    deleteFile: (input) => Promise.resolve(cloud.deleteFile({ fileList: [...input.fileList] }))
  };
}

export function createDefaultRuntimePhotoCleanupHandler(): () => Promise<PhotoCleanupSummary> {
  cloud.init();
  const database = adaptPhotoCleanupDatabase(cloud.database());
  return createRuntimePhotoCleanupHandler({
    database,
    storage: new CloudBasePrivatePhotoStorage(defaultCloudClient()),
    logger: cloud.logger()
  });
}
