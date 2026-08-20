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
  runTransaction(
    operation: (transaction: unknown) => Promise<unknown>
  ): unknown;
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

function isMissingDocumentError(value: unknown): boolean {
  if (!isRecord(value) || value.errCode !== -1 || typeof value.errMsg !== 'string') {
    return false;
  }
  return value.errMsg.startsWith('document.get:fail document with _id ')
    && value.errMsg.endsWith(' does not exist');
}

function requirePromise(value: unknown): Promise<unknown> {
  if (!(value instanceof Promise)) {
    return Promise.reject(new Error('CloudBase SDK did not return a Promise'));
  }
  return value;
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
        const data = 'data' in result ? result.data : undefined;
        return data === undefined || data === null ? {} : { data };
      } catch (error: unknown) {
        if (isMissingDocumentError(error)) return {};
        throw error;
      }
    },
    async set(input) {
      return requirePromise(value.set(input));
    },
    async remove() {
      return requirePromise(value.remove());
    }
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
      return {
        doc(id) {
          return adaptDocumentReference(collection.doc(id));
        }
      };
    }
  };
}

export function adaptWxCloudBaseDatabase(value: unknown): CloudBaseDatabase {
  if (!isRawDatabase(value)) throw new Error('CloudBase SDK returned an invalid database');
  const transaction = adaptTransaction(value);
  return {
    collection: (name) => transaction.collection(name),
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
