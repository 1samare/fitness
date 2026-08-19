import { randomUUID } from 'node:crypto';
import * as cloud from 'wx-server-sdk';
import {
  createIngredientPhotoPlanningService,
  type MealPlanningProviders
} from '@fitness/application';
import { planningApiRequestSchema, type PlanningApiResponse } from '@fitness/contracts';
import type {
  DailyMenuCatalogProvider,
  NutritionProvider,
  PrivatePhotoStorage,
  RecipeTemplateProvider,
  VisionProvider
} from '@fitness/domain';
import {
  CloudBasePlanningRepository,
  InMemoryPlanningRepository,
  type CloudBaseDatabase
} from '@fitness/persistence';
import {
  CloudBaseFunctionVisionBackend,
  CloudBasePrivatePhotoStorage,
  ReviewedNutritionCache,
  ResilientVisionProvider,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider,
  UnavailableVisionProvider,
  type CloudBasePrivateFileClient,
  type ProviderObservation
} from '@fitness/providers';
import {
  createPlanningApiHandler,
  type TrustedRequestContext
} from './handler';
import { adaptWxCloudBaseDatabase } from './wx-database-adapter';

interface CommonRuntimeOptions {
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
  readonly environment?: RuntimeEnvironment | undefined;
  readonly observeProvider?: ((event: ProviderObservation) => void) | undefined;
}

export interface RuntimeEnvironment {
  readonly CLOUDBASE_STORAGE_FILE_ID_PREFIX?: string | undefined;
  readonly FITNESS_VISION_FUNCTION_NAME?: string | undefined;
}

export interface RuntimeCloudClient extends CloudBasePrivateFileClient {
  callFunction(input: {
    readonly name: string;
    readonly data: { readonly privateFileId: string };
  }): Promise<unknown>;
}

export type RuntimePlanningHandlerOptions = CommonRuntimeOptions & (
  | {
      readonly runtimeMode: 'cloud';
      readonly database: CloudBaseDatabase;
      readonly cloud?: RuntimeCloudClient | undefined;
    }
  | {
      readonly runtimeMode: 'local';
      readonly storage?: PrivatePhotoStorage | undefined;
    }
);

const LOCAL_STORAGE_FILE_ID_PREFIX = 'cloud://local-fixture.bucket/';

function unavailableNutritionProvider(): NutritionProvider {
  return {
    getSnapshot: () => Promise.reject(new Error('production nutrition provider unavailable')),
    resolveCanonicalName: () => Promise.reject(new Error('production nutrition provider unavailable'))
  };
}

function unavailableRecipeProvider(): RecipeTemplateProvider {
  return {
    getByVersionId: () => Promise.reject(new Error('production recipe provider unavailable'))
  };
}

function unavailableMenuProvider(): DailyMenuCatalogProvider {
  return {
    getActiveCatalog: () => Promise.reject(new Error('production menu provider unavailable')),
    getMenuByVersionId: () => Promise.reject(new Error('production menu provider unavailable'))
  };
}

let localProviders: Promise<MealPlanningProviders> | undefined;

function loadLocalProviders(): Promise<MealPlanningProviders> {
  localProviders ??= import('@fitness/nutrition-fixtures').then((fixtures) => ({
    nutrition: new ReviewedNutritionCache({
      mode: 'test',
      snapshots: fixtures.TEST_MEAL_PLANNING_NUTRITION_SNAPSHOTS
    }),
    recipes: new StaticRecipeTemplateProvider({
      mode: 'test',
      templates: fixtures.TEST_MEAL_PLANNING_RECIPE_TEMPLATES
    }),
    menus: new StaticDailyMenuCatalogProvider({
      mode: 'test',
      catalog: fixtures.TEST_MEAL_PLANNING_DAILY_MENU_CATALOG,
      menus: fixtures.TEST_MEAL_PLANNING_DAILY_MENU_TEMPLATES
    }),
    allowTestFixtures: true
  }));
  return localProviders;
}

function lazyLocalProviders(): MealPlanningProviders {
  return {
    nutrition: {
      getSnapshot: async (id) => (await loadLocalProviders()).nutrition.getSnapshot(id),
      resolveCanonicalName: async (name) => (
        await loadLocalProviders()
      ).nutrition.resolveCanonicalName(name)
    },
    recipes: {
      getByVersionId: async (id) => (await loadLocalProviders()).recipes.getByVersionId(id)
    },
    menus: {
      getActiveCatalog: async () => (await loadLocalProviders()).menus.getActiveCatalog(),
      getMenuByVersionId: async (id) => (await loadLocalProviders()).menus.getMenuByVersionId(id)
    },
    allowTestFixtures: true
  };
}

function lazyLocalVisionProvider() {
  return {
    recognize: async () => {
      const { TEST_INGREDIENT_VISION_RESPONSE } = await import('@fitness/nutrition-fixtures');
      return {
        providerRequestId: TEST_INGREDIENT_VISION_RESPONSE.requestId,
        candidates: TEST_INGREDIENT_VISION_RESPONSE.candidates
      };
    }
  };
}

function unavailablePrivatePhotoStorage(): PrivatePhotoStorage {
  return {
    inspectPrivateFile: () => Promise.reject(new Error('private photo storage unavailable')),
    deletePrivateFile: () => Promise.reject(new Error('private photo storage unavailable'))
  };
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

function isIngredientPhotoAction(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const action = (input as { readonly action?: unknown }).action;
  return action === 'createIngredientPhotoUpload'
    || action === 'registerIngredientPhotoUpload'
    || action === 'recognizeIngredientPhoto'
    || action === 'confirmIngredientCandidate';
}

export function createRuntimeMealPlanningProviders(
  mode: 'local' | 'cloud'
): MealPlanningProviders {
  if (mode === 'cloud') {
    return {
      nutrition: unavailableNutritionProvider(),
      recipes: unavailableRecipeProvider(),
      menus: unavailableMenuProvider(),
      allowTestFixtures: false
    };
  }
  return lazyLocalProviders();
}

export function createRuntimePlanningHandler(options: RuntimePlanningHandlerOptions): (
  input: unknown,
  context?: TrustedRequestContext
) => Promise<PlanningApiResponse> {
  const repository = options.runtimeMode === 'cloud'
    ? new CloudBasePlanningRepository(options.database)
    : new InMemoryPlanningRepository();
  const providers = createRuntimeMealPlanningProviders(options.runtimeMode);
  const configuredStoragePrefix = options.environment?.CLOUDBASE_STORAGE_FILE_ID_PREFIX;
  const storagePrefix = options.runtimeMode === 'local'
    ? configuredStoragePrefix ?? LOCAL_STORAGE_FILE_ID_PREFIX
    : configuredStoragePrefix;
  const storageConfigurationValid = validStorageFileIdPrefix(storagePrefix);
  const safeStoragePrefix = storageConfigurationValid
    ? storagePrefix
    : 'cloud://invalid-runtime-configuration.bucket/';
  let storage: PrivatePhotoStorage;
  let vision: VisionProvider;
  if (options.runtimeMode === 'local') {
    storage = options.storage ?? unavailablePrivatePhotoStorage();
    vision = lazyLocalVisionProvider();
  } else {
    const cloudClient = options.cloud ?? defaultCloudClient();
    storage = new CloudBasePrivatePhotoStorage(cloudClient);
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
  }
  const service = createIngredientPhotoPlanningService({
    repository,
    providers,
    nutrition: providers.nutrition,
    vision,
    storage,
    storageFileIdPrefix: safeStoragePrefix,
    allowTestFixtures: providers.allowTestFixtures,
    now: options.now ?? (() => new Date().toISOString()),
    nextId: options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  });
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

export function createDefaultRuntimePlanningHandler() {
  if (process.env.FITNESS_RUNTIME_MODE === 'local') {
    return createRuntimePlanningHandler({ runtimeMode: 'local' });
  }
  cloud.init();
  return createRuntimePlanningHandler({
    runtimeMode: 'cloud',
    database: adaptWxCloudBaseDatabase(cloud.database()),
    environment: {
      CLOUDBASE_STORAGE_FILE_ID_PREFIX: process.env.CLOUDBASE_STORAGE_FILE_ID_PREFIX,
      FITNESS_VISION_FUNCTION_NAME: process.env.FITNESS_VISION_FUNCTION_NAME
    }
  });
}
