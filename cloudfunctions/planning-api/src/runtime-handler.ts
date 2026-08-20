import { randomUUID } from 'node:crypto';
import {
  createAccountDeletionGuardedRepository,
  createIngredientPhotoPlanningService,
  createPersonalDataService,
  type MealPlanningProviders
} from '@fitness/application';
import type { PlanningApiResponse } from '@fitness/contracts';
import type { PrivatePhotoStorage } from '@fitness/domain';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '@fitness/providers';
import { createPlanningApiHandler, type TrustedRequestContext } from './handler';
import {
  createCloudRuntimeMealPlanningProviders,
  createCloudRuntimePlanningHandler,
  createDefaultCloudRuntimePlanningHandler,
  type CloudRuntimePlanningHandlerOptions,
  type RuntimeEnvironment
} from './cloud-runtime-handler';

export {
  createProviderObservationSink,
  type ProviderObservationLogger,
  type RuntimeCloudClient,
  type RuntimeEnvironment
} from './cloud-runtime-handler';

interface LocalRuntimePlanningHandlerOptions {
  readonly runtimeMode: 'local';
  readonly storage?: PrivatePhotoStorage | undefined;
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
  readonly environment?: RuntimeEnvironment | undefined;
}

export type RuntimePlanningHandlerOptions =
  | CloudRuntimePlanningHandlerOptions
  | LocalRuntimePlanningHandlerOptions;

const LOCAL_STORAGE_FILE_ID_PREFIX = 'cloud://local-fixture.bucket/';

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
    deletePrivateFile: () => Promise.resolve('not_found')
  };
}

export function createRuntimeMealPlanningProviders(
  options: RuntimePlanningHandlerOptions
): MealPlanningProviders {
  if (options.runtimeMode === 'local') return lazyLocalProviders();
  return createCloudRuntimeMealPlanningProviders({
    database: options.database,
    datasetId: options.environment?.FITNESS_REVIEWED_DATASET_ID ?? '',
    now: options.now ?? (() => new Date().toISOString())
  });
}

function createLocalRuntimePlanningHandler(
  options: LocalRuntimePlanningHandlerOptions
): (input: unknown, context?: TrustedRequestContext) => Promise<PlanningApiResponse> {
  const providers = lazyLocalProviders();
  const storagePrefix = options.environment?.CLOUDBASE_STORAGE_FILE_ID_PREFIX
    ?? LOCAL_STORAGE_FILE_ID_PREFIX;
  const storage = options.storage ?? unavailablePrivatePhotoStorage();
  const rawRepository = new InMemoryPlanningRepository();
  const repository = createAccountDeletionGuardedRepository(rawRepository);
  const now = options.now ?? (() => new Date().toISOString());
  const planning = createIngredientPhotoPlanningService({
    repository,
    providers,
    nutrition: providers.nutrition,
    vision: lazyLocalVisionProvider(),
    storage,
    storageFileIdPrefix: storagePrefix,
    allowTestFixtures: true,
    now,
    nextId: options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  });
  const service = Object.assign(planning, createPersonalDataService({
    repository: rawRepository,
    storage,
    now
  }));
  return createPlanningApiHandler(service);
}

export function createRuntimePlanningHandler(
  options: RuntimePlanningHandlerOptions
): (input: unknown, context?: TrustedRequestContext) => Promise<PlanningApiResponse> {
  return options.runtimeMode === 'cloud'
    ? createCloudRuntimePlanningHandler(options)
    : createLocalRuntimePlanningHandler(options);
}

export function createDefaultRuntimePlanningHandler() {
  if (process.env.FITNESS_RUNTIME_MODE === 'local') {
    return createLocalRuntimePlanningHandler({ runtimeMode: 'local' });
  }
  return createDefaultCloudRuntimePlanningHandler();
}
