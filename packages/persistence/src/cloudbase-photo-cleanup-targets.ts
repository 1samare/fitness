import { latestIngredientPhotoVersions } from '@fitness/domain';
import type { PhotoCleanupTargetRepository } from '@fitness/application';
import { decodePlanningDocumentForCleanup } from './cloudbase-planning-repository';

const COLLECTION_NAME = 'planning_user_states';
const MAXIMUM_BATCH_SIZE = 50;
const MAXIMUM_SCANNED_DOCUMENTS = MAXIMUM_BATCH_SIZE * 5;

export interface CloudBasePhotoCleanupQuery {
  orderBy(path: string, direction: 'asc' | 'desc'): CloudBasePhotoCleanupQuery;
  skip(value: number): CloudBasePhotoCleanupQuery;
  limit(value: number): CloudBasePhotoCleanupQuery;
  get(): Promise<{ readonly data?: unknown }>;
}

interface CloudBasePhotoCleanupCollection {
  where(filter: Readonly<Record<string, unknown>>): CloudBasePhotoCleanupQuery;
}

export interface CloudBasePhotoCleanupQueryDatabase {
  readonly command: { lte(value: string): unknown };
  collection(name: string): CloudBasePhotoCleanupCollection;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export class CloudBasePhotoCleanupTargetRepository implements PhotoCleanupTargetRepository {
  public constructor(private readonly database: CloudBasePhotoCleanupQueryDatabase) {}

  public async listDueTargets(input: {
    readonly before: string;
    readonly limit: number;
  }): Promise<readonly { readonly userId: string; readonly photoId: string }[]> {
    const limit = Math.max(0, Math.min(MAXIMUM_BATCH_SIZE, Math.floor(input.limit)));
    if (limit === 0) return [];
    const query = this.database.collection(COLLECTION_NAME)
      .where({
        'state.nextPhotoCleanupAt': this.database.command.lte(input.before)
      })
      .orderBy('state.nextPhotoCleanupAt', 'asc')
      .orderBy('state.userId', 'asc');

    const documents: unknown[] = [];
    let offset = 0;
    while (offset < MAXIMUM_SCANNED_DOCUMENTS) {
      const pageLimit = Math.min(
        MAXIMUM_BATCH_SIZE,
        MAXIMUM_SCANNED_DOCUMENTS - offset
      );
      const response = await query.skip(offset).limit(pageLimit).get();
      if (!isUnknownArray(response.data) || response.data.length > pageLimit) {
        throw new Error('CloudBase cleanup query returned invalid data');
      }
      for (const document of response.data) documents.push(document);
      if (response.data.length < pageLimit) break;
      offset += response.data.length;
    }

    const dueTargets = documents.flatMap((document) => {
      try {
        const decoded = decodePlanningDocumentForCleanup(document);
        return latestIngredientPhotoVersions(decoded.state.ingredientPhotoVersions)
          .filter((photo) => (
            photo.storageStatus !== 'deleted'
            && photo.nextCleanupAt !== null
            && photo.nextCleanupAt <= input.before
          ))
          .map((photo) => ({
            userId: decoded.userId,
            photoId: photo.photoId,
            nextCleanupAt: photo.nextCleanupAt
          }));
      } catch {
        return [];
      }
    });
    dueTargets.sort((left, right) => (
      compareCodeUnits(left.nextCleanupAt ?? '', right.nextCleanupAt ?? '')
      || compareCodeUnits(left.userId, right.userId)
      || compareCodeUnits(left.photoId, right.photoId)
    ));
    return dueTargets.slice(0, limit).map(({ userId, photoId }) => ({ userId, photoId }));
  }
}
