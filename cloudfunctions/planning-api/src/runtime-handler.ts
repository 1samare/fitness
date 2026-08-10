import { randomUUID } from 'node:crypto';
import * as cloud from 'wx-server-sdk';
import {
  createMealPlanGenerationService,
  type MealPlanningProviders
} from '@fitness/application';
import type { PlanningApiResponse } from '@fitness/contracts';
import type {
  DailyMenuCatalogProvider,
  NutritionProvider,
  RecipeTemplateProvider
} from '@fitness/domain';
import {
  CloudBasePlanningRepository,
  InMemoryPlanningRepository,
  type CloudBaseDatabase
} from '@fitness/persistence';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '@fitness/providers';
import {
  createPlanningApiHandler,
  type TrustedRequestContext
} from './handler';
import { adaptWxCloudBaseDatabase } from './wx-database-adapter';

interface CommonRuntimeOptions {
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
}

export type RuntimePlanningHandlerOptions = CommonRuntimeOptions & (
  | {
      readonly runtimeMode: 'cloud';
      readonly database: CloudBaseDatabase;
    }
  | {
      readonly runtimeMode: 'local';
    }
);

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
      snapshots: fixtures.TEST_NUTRITION_SNAPSHOTS
    }),
    recipes: new StaticRecipeTemplateProvider({
      mode: 'test',
      templates: fixtures.TEST_RECIPE_TEMPLATES
    }),
    menus: new StaticDailyMenuCatalogProvider({
      mode: 'test',
      catalog: fixtures.TEST_DAILY_MENU_CATALOG,
      menus: fixtures.TEST_DAILY_MENU_TEMPLATES
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
  const service = createMealPlanGenerationService({
    repository,
    providers: createRuntimeMealPlanningProviders(options.runtimeMode),
    now: options.now ?? (() => new Date().toISOString()),
    nextId: options.nextId ?? ((prefix) => `${prefix}-${randomUUID()}`)
  });
  return createPlanningApiHandler(service);
}

export function createDefaultRuntimePlanningHandler() {
  if (process.env.FITNESS_RUNTIME_MODE === 'local') {
    return createRuntimePlanningHandler({ runtimeMode: 'local' });
  }
  cloud.init();
  return createRuntimePlanningHandler({
    runtimeMode: 'cloud',
    database: adaptWxCloudBaseDatabase(cloud.database())
  });
}
