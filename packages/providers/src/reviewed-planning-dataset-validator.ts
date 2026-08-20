import { createHash } from 'node:crypto';
import {
  reviewedPlanningDatasetV1Schema,
  type ReviewedPlanningDatasetV1
} from '@fitness/contracts';

export class InvalidReviewedPlanningDatasetError extends Error {
  public readonly code = 'invalid_reviewed_planning_dataset' as const;

  public constructor() {
    super('Reviewed planning dataset failed validation');
    this.name = 'InvalidReviewedPlanningDatasetError';
  }
}

type DatasetWithoutChecksum = Omit<ReviewedPlanningDatasetV1, 'checksumSha256'>;

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)])
    );
  }
  return value;
}

export function canonicalReviewedDatasetPayload(
  dataset: DatasetWithoutChecksum | ReviewedPlanningDatasetV1
): string {
  const payload: Partial<ReviewedPlanningDatasetV1> = { ...dataset };
  delete payload.checksumSha256;
  return JSON.stringify(sortJsonValue(payload));
}

function checksumFor(dataset: ReviewedPlanningDatasetV1): string {
  return createHash('sha256')
    .update(canonicalReviewedDatasetPayload(dataset), 'utf8')
    .digest('hex');
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new InvalidReviewedPlanningDatasetError();
}

function isoTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new InvalidReviewedPlanningDatasetError();
  return parsed;
}

function assertEnvelopeAndLicense(dataset: ReviewedPlanningDatasetV1, now: string): void {
  const nowTime = isoTime(now);
  const reviewedTime = isoTime(dataset.reviewedAt);
  const activatedTime = isoTime(dataset.activatedAt);
  const validUntilTime = isoTime(dataset.validUntil);
  if (
    reviewedTime > nowTime
    || activatedTime < reviewedTime
    || activatedTime > nowTime
    || nowTime >= validUntilTime
  ) {
    throw new InvalidReviewedPlanningDatasetError();
  }

  assertUnique(dataset.sourceReferences.map((source) => source.sourceId));
  for (const source of dataset.sourceReferences) {
    if (source.authorizationValidUntil !== null) {
      const authorizationEnd = isoTime(source.authorizationValidUntil);
      if (nowTime >= authorizationEnd || validUntilTime > authorizationEnd) {
        throw new InvalidReviewedPlanningDatasetError();
      }
    }
  }
}

function assertRecordMetadata(dataset: ReviewedPlanningDatasetV1): void {
  const sourceIds = new Set(dataset.sourceReferences.map((source) => source.sourceId));
  const records = [
    ...dataset.nutritionSnapshots,
    ...dataset.recipeTemplates,
    ...dataset.dailyMenus,
    dataset.menuCatalog
  ];
  assertUnique(records.map((record) => record.id));

  const datasetReviewTime = isoTime(dataset.reviewedAt);
  for (const record of records) {
    if (
      record.datasetVersion !== dataset.datasetVersion
      || !sourceIds.has(record.sourceId)
      || record.qualityStatus !== 'reviewed'
      || isoTime(record.reviewedAt) > datasetReviewTime
    ) {
      throw new InvalidReviewedPlanningDatasetError();
    }
  }
}

function assertClosedGraph(dataset: ReviewedPlanningDatasetV1): void {
  const snapshots = new Map(dataset.nutritionSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const recipes = new Map(dataset.recipeTemplates.map((recipe) => [recipe.id, recipe]));
  const menus = new Map(dataset.dailyMenus.map((menu) => [menu.id, menu]));

  const reachableMenuIds = new Set(dataset.menuCatalog.dailyMenuTemplateVersionIds);
  if (
    reachableMenuIds.size !== 7
    || reachableMenuIds.size !== menus.size
    || [...reachableMenuIds].some((id) => !menus.has(id))
  ) {
    throw new InvalidReviewedPlanningDatasetError();
  }

  const reachableRecipeIds = new Set<string>();
  for (const menuId of reachableMenuIds) {
    const menu = menus.get(menuId);
    if (menu === undefined) throw new InvalidReviewedPlanningDatasetError();
    for (const meal of menu.meals) {
      if (!recipes.has(meal.recipeTemplateVersionId)) {
        throw new InvalidReviewedPlanningDatasetError();
      }
      reachableRecipeIds.add(meal.recipeTemplateVersionId);
    }
  }
  if (
    reachableRecipeIds.size !== recipes.size
    || [...recipes.keys()].some((id) => !reachableRecipeIds.has(id))
  ) {
    throw new InvalidReviewedPlanningDatasetError();
  }

  const reachableSnapshotIds = new Set<string>();
  for (const recipeId of reachableRecipeIds) {
    const recipe = recipes.get(recipeId);
    if (recipe === undefined) throw new InvalidReviewedPlanningDatasetError();
    for (const ingredient of recipe.ingredients) {
      const snapshot = snapshots.get(ingredient.nutritionSnapshotId);
      if (snapshot === undefined || snapshot.foodId !== ingredient.foodId) {
        throw new InvalidReviewedPlanningDatasetError();
      }
      reachableSnapshotIds.add(ingredient.nutritionSnapshotId);
    }
  }
  if (
    reachableSnapshotIds.size !== snapshots.size
    || [...snapshots.keys()].some((id) => !reachableSnapshotIds.has(id))
  ) {
    throw new InvalidReviewedPlanningDatasetError();
  }
}

export function validateReviewedPlanningDataset(
  value: unknown,
  now: string
): ReviewedPlanningDatasetV1 {
  const parsed = reviewedPlanningDatasetV1Schema.safeParse(value);
  if (!parsed.success) throw new InvalidReviewedPlanningDatasetError();

  const dataset = parsed.data;
  if (checksumFor(dataset) !== dataset.checksumSha256) {
    throw new InvalidReviewedPlanningDatasetError();
  }
  assertEnvelopeAndLicense(dataset, now);
  assertRecordMetadata(dataset);
  assertClosedGraph(dataset);
  return structuredClone(dataset);
}
