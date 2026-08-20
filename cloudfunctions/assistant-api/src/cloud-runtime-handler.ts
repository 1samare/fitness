import { randomUUID } from 'node:crypto';
import tcb from '@cloudbase/node-sdk';
import {
  ProviderUnavailableError,
  createMealPlanRecalculationService,
  type MealPlanningProviders
} from '@fitness/application';
import type { AssistantApiResponse } from '@fitness/contracts';
import type {
  DailyMenuCatalogProvider,
  NutritionProvider,
  RecipeTemplateProvider
} from '@fitness/domain';
import {
  CloudBasePlanningRepository,
  type CloudBaseDatabase
} from '@fitness/persistence';
import {
  CloudBaseLanguageModelBackend,
  ResilientLanguageModelProvider,
  type CloudBaseTextModel,
  type LanguageModelProviderObservation
} from '@fitness/providers';
import * as cloud from 'wx-server-sdk';
import {
  createAssistantApiComposition,
  type TrustedAssistantRequestContext
} from './handler';
import { adaptWxCloudBaseDatabase } from './wx-database-adapter';

export interface AssistantRuntimeEnvironment {
  readonly CLOUDBASE_ENV_ID?: string | undefined;
  readonly FITNESS_AI_PROVIDER_ID?: string | undefined;
  readonly FITNESS_AI_MODEL_NAME?: string | undefined;
}

export class AssistantRuntimeConfigurationError extends Error {
  public readonly code = 'assistant_runtime_configuration_invalid' as const;

  public constructor() {
    super('Assistant runtime configuration is invalid');
    this.name = 'AssistantRuntimeConfigurationError';
  }
}

export interface LanguageModelObservationLogger {
  info(entry: LanguageModelProviderObservation & {
    readonly event: 'language_model_provider_observation';
  }): void;
}

export function createLanguageModelObservationSink(
  logger: LanguageModelObservationLogger
): (event: LanguageModelProviderObservation) => void {
  return (event) => {
    logger.info({ event: 'language_model_provider_observation', ...event });
  };
}

export interface CloudRuntimeAssistantHandlerOptions {
  readonly runtimeMode: 'cloud';
  readonly database: CloudBaseDatabase;
  readonly environment: AssistantRuntimeEnvironment;
  readonly createModel: (providerId: string) => CloudBaseTextModel;
  readonly observeProvider?: ((event: LanguageModelProviderObservation) => void) | undefined;
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
}

function requiredIdentifier(value: string | undefined): string {
  const normalized = value?.trim();
  if (normalized === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new AssistantRuntimeConfigurationError();
  }
  return normalized;
}

function unavailableNutrition(): NutritionProvider {
  return {
    getSnapshot: () => Promise.reject(
      new ProviderUnavailableError('nutrition_source_unavailable')
    ),
    resolveCanonicalName: () => Promise.reject(
      new ProviderUnavailableError('nutrition_source_unavailable')
    )
  };
}

function unavailableRecipes(): RecipeTemplateProvider {
  return {
    getByVersionId: () => Promise.reject(
      new ProviderUnavailableError('meal_catalog_unavailable')
    )
  };
}

function unavailableMenus(): DailyMenuCatalogProvider {
  return {
    getActiveCatalog: () => Promise.reject(
      new ProviderUnavailableError('meal_catalog_unavailable')
    ),
    getMenuByVersionId: () => Promise.reject(
      new ProviderUnavailableError('meal_catalog_unavailable')
    )
  };
}

function cloudMealPlanningProviders(): MealPlanningProviders {
  return {
    nutrition: unavailableNutrition(),
    recipes: unavailableRecipes(),
    menus: unavailableMenus(),
    allowTestFixtures: false
  };
}

export function createCloudRuntimeAssistantHandler(
  options: CloudRuntimeAssistantHandlerOptions
): (
  input: unknown,
  context?: TrustedAssistantRequestContext
) => Promise<AssistantApiResponse> {
  requiredIdentifier(options.environment.CLOUDBASE_ENV_ID);
  const providerId = requiredIdentifier(options.environment.FITNESS_AI_PROVIDER_ID);
  const modelName = requiredIdentifier(options.environment.FITNESS_AI_MODEL_NAME);
  const model = options.createModel(providerId);
  const repository = new CloudBasePlanningRepository(options.database);
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const planning = createMealPlanRecalculationService({
    repository,
    providers: cloudMealPlanningProviders(),
    now,
    nextId
  });
  const backend = new CloudBaseLanguageModelBackend({ providerId, modelName, model });
  const provider = new ResilientLanguageModelProvider({
    providerId,
    modelName,
    backend,
    nowMs: () => Date.now(),
    observe: options.observeProvider ?? (() => undefined)
  });
  return createAssistantApiComposition({
    repository,
    planning,
    provider,
    now,
    nextId
  });
}

export function createDefaultCloudRuntimeAssistantHandler() {
  const environment: AssistantRuntimeEnvironment = {
    CLOUDBASE_ENV_ID: process.env.CLOUDBASE_ENV_ID,
    FITNESS_AI_PROVIDER_ID: process.env.FITNESS_AI_PROVIDER_ID,
    FITNESS_AI_MODEL_NAME: process.env.FITNESS_AI_MODEL_NAME
  };
  const environmentId = requiredIdentifier(environment.CLOUDBASE_ENV_ID);
  cloud.init();
  const app = tcb.init({ env: environmentId });
  const ai = app.ai();
  return createCloudRuntimeAssistantHandler({
    runtimeMode: 'cloud',
    database: adaptWxCloudBaseDatabase(cloud.database()),
    environment,
    createModel: (providerId) => {
      const model = ai.createModel(providerId);
      return {
        generateText: (input) => model.generateText({
          model: input.model,
          messages: input.messages.map((message) => {
            if (message.role === 'assistant') {
              return { role: 'assistant' as const, content: message.content, tool_calls: [] };
            }
            if (message.role === 'system') {
              return { role: 'system' as const, content: message.content };
            }
            return { role: 'user' as const, content: message.content };
          })
        })
      };
    },
    observeProvider: createLanguageModelObservationSink(cloud.logger())
  });
}
