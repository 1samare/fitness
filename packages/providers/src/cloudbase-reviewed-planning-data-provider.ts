import type { ReviewedPlanningDatasetV1 } from '@fitness/contracts';
import type {
  DailyMenuCatalogProvider,
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion,
  FoodResolution,
  NutritionDataSnapshot,
  NutritionProvider,
  RecipeTemplateProvider,
  RecipeTemplateVersion
} from '@fitness/domain';
import {
  InvalidReviewedPlanningDatasetError,
  validateReviewedPlanningDataset
} from './reviewed-planning-dataset-validator';

export interface ReviewedPlanningDatasetSource {
  read(datasetId: string): Promise<unknown>;
}

export interface CloudBaseReviewedPlanningDataProviderOptions {
  readonly datasetId: string;
  readonly source: ReviewedPlanningDatasetSource;
  readonly now: () => string;
  readonly nowMs: () => number;
  readonly cacheTtlMs: number;
  readonly loadTimeoutMs: number;
}

export class ReviewedDatasetConfigurationError extends Error {
  public readonly code = 'reviewed_dataset_configuration_invalid' as const;

  public constructor() {
    super('Reviewed dataset configuration is invalid');
    this.name = 'ReviewedDatasetConfigurationError';
  }
}

export class ReviewedDatasetUnavailableError extends Error {
  public readonly code = 'reviewed_dataset_unavailable' as const;

  public constructor() {
    super('Reviewed planning dataset is unavailable');
    this.name = 'ReviewedDatasetUnavailableError';
  }
}

export function requireReviewedDatasetId(value: string | undefined): string {
  const normalized = value?.trim();
  if (
    normalized === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)
  ) {
    throw new ReviewedDatasetConfigurationError();
  }
  return normalized;
}

function normalizeFoodName(value: string): string {
  return value.trim().replaceAll(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

export class CloudBaseReviewedPlanningDataProvider
implements NutritionProvider, RecipeTemplateProvider, DailyMenuCatalogProvider {
  private readonly datasetId: string;
  private readonly source: ReviewedPlanningDatasetSource;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly cacheTtlMs: number;
  private readonly loadTimeoutMs: number;
  private cached: { readonly dataset: ReviewedPlanningDatasetV1; readonly loadedAtMs: number }
    | undefined;
  private inFlight: Promise<ReviewedPlanningDatasetV1> | undefined;

  public constructor(options: CloudBaseReviewedPlanningDataProviderOptions) {
    this.datasetId = requireReviewedDatasetId(options.datasetId);
    if (
      !Number.isFinite(options.cacheTtlMs)
      || options.cacheTtlMs < 0
      || !Number.isFinite(options.loadTimeoutMs)
      || options.loadTimeoutMs <= 0
    ) {
      throw new ReviewedDatasetConfigurationError();
    }
    this.source = options.source;
    this.now = options.now;
    this.nowMs = options.nowMs;
    this.cacheTtlMs = options.cacheTtlMs;
    this.loadTimeoutMs = options.loadTimeoutMs;
  }

  private async readAndValidate(): Promise<ReviewedPlanningDatasetV1> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        this.source.read(this.datasetId),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new ReviewedDatasetUnavailableError());
          }, this.loadTimeoutMs);
        })
      ]);
      if (value === null) throw new ReviewedDatasetUnavailableError();
      const dataset = validateReviewedPlanningDataset(value, this.now());
      this.cached = { dataset, loadedAtMs: this.nowMs() };
      return dataset;
    } catch (error: unknown) {
      this.cached = undefined;
      if (error instanceof ReviewedDatasetUnavailableError) throw error;
      if (error instanceof InvalidReviewedPlanningDatasetError) {
        throw new ReviewedDatasetUnavailableError();
      }
      throw new ReviewedDatasetUnavailableError();
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private loadFreshShared(): Promise<ReviewedPlanningDatasetV1> {
    if (this.inFlight !== undefined) return this.inFlight;
    const pending = this.readAndValidate();
    this.inFlight = pending;
    void pending.finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined;
    }).catch(() => undefined);
    return pending;
  }

  private loadValidDataset(): Promise<ReviewedPlanningDatasetV1> {
    const cached = this.cached;
    if (cached !== undefined && this.nowMs() - cached.loadedAtMs < this.cacheTtlMs) {
      try {
        return Promise.resolve(validateReviewedPlanningDataset(cached.dataset, this.now()));
      } catch {
        this.cached = undefined;
        return Promise.reject(new ReviewedDatasetUnavailableError());
      }
    }
    this.cached = undefined;
    return this.loadFreshShared();
  }

  public async getSnapshot(snapshotId: string): Promise<NutritionDataSnapshot> {
    const dataset = await this.loadValidDataset();
    const snapshot = dataset.nutritionSnapshots.find((record) => record.id === snapshotId);
    if (snapshot === undefined) throw new ReviewedDatasetUnavailableError();
    return structuredClone(snapshot);
  }

  public async resolveCanonicalName(name: string): Promise<FoodResolution | null> {
    const dataset = await this.loadValidDataset();
    const normalized = normalizeFoodName(name);
    const matches = dataset.nutritionSnapshots.filter(
      (snapshot) => normalizeFoodName(snapshot.canonicalNameZh) === normalized
    );
    const [snapshot] = matches;
    if (matches.length !== 1 || snapshot === undefined) return null;
    return {
      foodId: snapshot.foodId,
      canonicalNameZh: snapshot.canonicalNameZh,
      nutritionSnapshotId: snapshot.id
    };
  }

  public async getByVersionId(versionId: string): Promise<RecipeTemplateVersion> {
    const dataset = await this.loadValidDataset();
    const recipe = dataset.recipeTemplates.find((record) => record.id === versionId);
    if (recipe === undefined) throw new ReviewedDatasetUnavailableError();
    return structuredClone(recipe);
  }

  public async getActiveCatalog(): Promise<DailyMenuCatalogVersion> {
    const dataset = await this.loadValidDataset();
    return structuredClone(dataset.menuCatalog);
  }

  public async getMenuByVersionId(versionId: string): Promise<DailyMenuTemplateVersion> {
    const dataset = await this.loadValidDataset();
    const menu = dataset.dailyMenus.find((record) => record.id === versionId);
    if (menu === undefined) throw new ReviewedDatasetUnavailableError();
    return structuredClone(menu);
  }
}
