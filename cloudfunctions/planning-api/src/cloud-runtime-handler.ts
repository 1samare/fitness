import { randomUUID } from 'node:crypto';
import * as cloud from 'wx-server-sdk';
import {
  createAccountDeletionGuardedRepository,
  createIngredientPhotoPlanningService,
  createPersonalDataService,
  type MealPlanningProviders
} from '@fitness/application';
import { planningApiRequestSchema, type PlanningApiResponse } from '@fitness/contracts';
import type { VisionProvider } from '@fitness/domain';
import { CloudBasePlanningRepository, type CloudBaseDatabase } from '@fitness/persistence';
import {
  CloudBaseFunctionVisionBackend,
  CloudBasePrivatePhotoStorage,
  CloudBaseReviewedPlanningDataProvider,
  ResilientVisionProvider,
  UnavailableVisionProvider,
  requireReviewedDatasetId,
  type CloudBasePrivateFileClient,
  type ProviderObservation
} from '@fitness/providers';
import { createPlanningApiHandler, type TrustedRequestContext } from './handler';
import {
  adaptWxCloudBaseDatabase,
  createCloudBaseReviewedDatasetSource
} from './wx-database-adapter';

interface CommonRuntimeOptions {
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
  readonly environment?: RuntimeEnvironment | undefined;
  readonly observeProvider?: ((event: ProviderObservation) => void) | undefined;
}

export interface RuntimeEnvironment {
  readonly CLOUDBASE_STORAGE_FILE_ID_PREFIX?: string | undefined;
  readonly FITNESS_VISION_FUNCTION_NAME?: string | undefined;
  readonly FITNESS_REVIEWED_DATASET_ID?: string | undefined;
}

export interface RuntimeCloudClient extends CloudBasePrivateFileClient {
  callFunction(input: {
    readonly name: string;
    readonly data: { readonly privateFileId: string };
  }): Promise<unknown>;
}

export interface ProviderObservationLogger {
  info(entry: {
    readonly event: 'vision_provider_observation';
    readonly provider: string;
    readonly requestId: string;
    readonly attempt: number;
    readonly latencyMs: number;
    readonly status: 'succeeded' | 'failed';
    readonly stableErrorCode: 'provider_unavailable' | null;
    readonly estimatedCostUnits: number | null;
  }): void;
}

export interface CloudRuntimePlanningHandlerOptions extends CommonRuntimeOptions {
  readonly runtimeMode: 'cloud';
  readonly database: CloudBaseDatabase;
  readonly cloud?: RuntimeCloudClient | undefined;
}

function defaultCloudClient(): RuntimeCloudClient {
  return {
    callFunction: (input) => Promise.resolve(cloud.callFunction(input)),
    downloadFile: (input) => cloud.downloadFile(input),
    deleteFile: (input) => Promise.resolve(cloud.deleteFile({ fileList: [...input.fileList] }))
  };
}

function validStorageFileIdPrefix(value: string | undefined): value is string {
  return value !== undefined && /^cloud:\/\/[^/\s]+\/?$/.test(value);
}

export function createProviderObservationSink(
  logger: ProviderObservationLogger
): (event: ProviderObservation) => void {
  return (event) => {
    logger.info({
      event: 'vision_provider_observation',
      provider: event.provider,
      requestId: event.requestId,
      attempt: event.attempt,
      latencyMs: event.latencyMs,
      status: event.status,
      stableErrorCode: event.stableErrorCode ?? null,
      estimatedCostUnits: event.estimatedCostUnits ?? null
    });
  };
}

function isIngredientPhotoAction(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const action = (input as { readonly action?: unknown }).action;
  return action === 'createIngredientPhotoUpload'
    || action === 'registerIngredientPhotoUpload'
    || action === 'recognizeIngredientPhoto'
    || action === 'confirmIngredientCandidate';
}

export function createCloudRuntimeMealPlanningProviders(input: {
  readonly database: CloudBaseDatabase;
  readonly datasetId: string;
  readonly now: () => string;
}): MealPlanningProviders {
  const reviewed = new CloudBaseReviewedPlanningDataProvider({
    datasetId: requireReviewedDatasetId(input.datasetId),
    source: createCloudBaseReviewedDatasetSource(input.database),
    now: input.now,
    nowMs: () => Date.now(),
    cacheTtlMs: 60_000,
    loadTimeoutMs: 2_000
  });
  return {
    nutrition: reviewed,
    recipes: reviewed,
    menus: reviewed,
    allowTestFixtures: false
  };
}

export function createCloudRuntimePlanningHandler(
  options: CloudRuntimePlanningHandlerOptions
): (input: unknown, context?: TrustedRequestContext) => Promise<PlanningApiResponse> {
  const rawRepository = new CloudBasePlanningRepository(options.database);
  const repository = createAccountDeletionGuardedRepository(rawRepository);
  const now = options.now ?? (() => new Date().toISOString());
  const providers = createCloudRuntimeMealPlanningProviders({
    database: options.database,
    datasetId: requireReviewedDatasetId(options.environment?.FITNESS_REVIEWED_DATASET_ID),
    now
  });
  const storagePrefix = options.environment?.CLOUDBASE_STORAGE_FILE_ID_PREFIX;
  const storageConfigurationValid = validStorageFileIdPrefix(storagePrefix);
  const safeStoragePrefix = storageConfigurationValid
    ? storagePrefix
    : 'cloud://invalid-runtime-configuration.bucket/';
  const cloudClient = options.cloud ?? defaultCloudClient();
  const storage = new CloudBasePrivatePhotoStorage(cloudClient);
  let vision: VisionProvider;
  const functionName = options.environment?.FITNESS_VISION_FUNCTION_NAME;
  if (functionName === undefined) {
    vision = new UnavailableVisionProvider();
  } else {
    try {
      vision = new ResilientVisionProvider({
        providerName: 'cloudbase-ai-vision',
        backend: new CloudBaseFunctionVisionBackend(
          (input) => cloudClient.callFunction(input),
          functionName
        ),
        nowMs: () => Date.now(),
        observe: options.observeProvider ?? (() => undefined)
      });
    } catch {
      vision = new UnavailableVisionProvider();
    }
  }
  const planning = createIngredientPhotoPlanningService({
    repository,
    providers,
    nutrition: providers.nutrition,
    vision,
    storage,
    storageFileIdPrefix: safeStoragePrefix,
    allowTestFixtures: false,
    now,
    nextId: options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  });
  const service = Object.assign(planning, createPersonalDataService({
    repository: rawRepository,
    storage,
    now
  }));
  const handler = createPlanningApiHandler(service);
  return async (input, context) => {
    if (!storageConfigurationValid && isIngredientPhotoAction(input)) {
      if (context === undefined || !planningApiRequestSchema.safeParse(input).success) {
        return handler(input, context);
      }
      return {
        success: false,
        error: {
          code: 'storage_unavailable',
          message: '图片存储暂时不可用，请重新选择图片。'
        }
      };
    }
    return handler(input, context);
  };
}

export function createDefaultCloudRuntimePlanningHandler() {
  cloud.init();
  return createCloudRuntimePlanningHandler({
    runtimeMode: 'cloud',
    database: adaptWxCloudBaseDatabase(cloud.database()),
    environment: {
      CLOUDBASE_STORAGE_FILE_ID_PREFIX: process.env.CLOUDBASE_STORAGE_FILE_ID_PREFIX,
      FITNESS_VISION_FUNCTION_NAME: process.env.FITNESS_VISION_FUNCTION_NAME,
      FITNESS_REVIEWED_DATASET_ID: process.env.FITNESS_REVIEWED_DATASET_ID
    },
    observeProvider: createProviderObservationSink(cloud.logger())
  });
}
