import type {
  CloudBaseDatabase,
  CloudBaseDocumentReference,
  CloudBaseTransaction
} from '@fitness/persistence';

interface RawDocumentReference {
  get(): unknown;
  set(input: { readonly data: unknown }): unknown;
  remove(): unknown;
}

interface RawCollection {
  doc(id: string): unknown;
}

interface RawTransaction {
  collection(name: string): unknown;
}

interface RawDatabase extends RawTransaction {
  runTransaction(operation: (transaction: unknown) => Promise<unknown>): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawDocumentReference(value: unknown): value is RawDocumentReference {
  return isRecord(value)
    && typeof value.get === 'function'
    && typeof value.set === 'function'
    && typeof value.remove === 'function';
}

function isRawCollection(value: unknown): value is RawCollection {
  return isRecord(value) && typeof value.doc === 'function';
}

function isRawTransaction(value: unknown): value is RawTransaction {
  return isRecord(value) && typeof value.collection === 'function';
}

function isRawDatabase(value: unknown): value is RawDatabase {
  return isRecord(value)
    && typeof value.collection === 'function'
    && typeof value.runTransaction === 'function';
}

function requirePromise(value: unknown): Promise<unknown> {
  return value instanceof Promise
    ? value
    : Promise.reject(new Error('CloudBase SDK did not return a Promise'));
}

function isMissingDocumentError(value: unknown): boolean {
  return isRecord(value)
    && value.errCode === -1
    && typeof value.errMsg === 'string'
    && value.errMsg.startsWith('document.get:fail document with _id ')
    && value.errMsg.endsWith(' does not exist');
}

function adaptDocumentReference(value: unknown): CloudBaseDocumentReference {
  if (!isRawDocumentReference(value)) {
    throw new Error('CloudBase SDK returned an invalid document reference');
  }
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
    set: (input) => requirePromise(value.set(input)),
    remove: () => requirePromise(value.remove())
  };
}

function adaptTransaction(value: unknown): CloudBaseTransaction {
  if (!isRawTransaction(value)) {
    throw new Error('CloudBase SDK returned an invalid transaction');
  }
  return {
    collection(name) {
      const collection = value.collection(name);
      if (!isRawCollection(collection)) {
        throw new Error('CloudBase SDK returned an invalid collection');
      }
      return { doc: (id) => adaptDocumentReference(collection.doc(id)) };
    }
  };
}

export function adaptWxCloudBaseDatabase(value: unknown): CloudBaseDatabase {
  if (!isRawDatabase(value)) {
    throw new Error('CloudBase SDK returned an invalid database');
  }
  const transaction = adaptTransaction(value);
  return {
    collection: (name) => transaction.collection(name),
    async runTransaction<TResult>(
      operation: (current: CloudBaseTransaction) => Promise<TResult>
    ): Promise<TResult> {
      let callbackResult: { readonly value: TResult } | undefined;
      await requirePromise(value.runTransaction(async (rawTransaction) => {
        const result = await operation(adaptTransaction(rawTransaction));
        callbackResult = { value: result };
        return result;
      }));
      if (callbackResult === undefined) {
        throw new Error('CloudBase transaction completed without a callback result');
      }
      return callbackResult.value;
    }
  };
}
