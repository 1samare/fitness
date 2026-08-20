import { randomUUID } from 'node:crypto';
import tcb from '@cloudbase/node-sdk';
import {
  createAccountDeletionGuardedRepository,
  createMealPlanRecalculationService,
  type MealPlanningProviders
} from '@fitness/application';
import type { AssistantApiResponse } from '@fitness/contracts';
import {
  CloudBasePlanningRepository,
  type CloudBaseDatabase
} from '@fitness/persistence';
import {
  CloudBaseLanguageModelBackend,
  CloudBaseReviewedPlanningDataProvider,
  ResilientLanguageModelProvider,
  requireReviewedDatasetId,
  type CloudBaseTextModel,
  type LanguageModelProviderObservation
} from '@fitness/providers';
import * as cloud from 'wx-server-sdk';
import {
  createAssistantApiComposition,
  type TrustedAssistantRequestContext
} from './handler';
import {
  adaptWxCloudBaseDatabase,
  createCloudBaseReviewedDatasetSource
} from './wx-database-adapter';

export interface AssistantRuntimeEnvironment {
  readonly CLOUDBASE_ENV_ID?: string | undefined;
  readonly FITNESS_LLM_PROVIDER_ID?: string | undefined;
  readonly FITNESS_LLM_MODEL?: string | undefined;
  readonly FITNESS_REVIEWED_DATASET_ID?: string | undefined;
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

export function createCloudRuntimeAssistantMealPlanningProviders(input: {
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

export function createCloudRuntimeAssistantHandler(
  options: CloudRuntimeAssistantHandlerOptions
): (
  input: unknown,
  context?: TrustedAssistantRequestContext
) => Promise<AssistantApiResponse> {
  requiredIdentifier(options.environment.CLOUDBASE_ENV_ID);
  const providerId = requiredIdentifier(options.environment.FITNESS_LLM_PROVIDER_ID);
  const modelName = requiredIdentifier(options.environment.FITNESS_LLM_MODEL);
  const datasetId = requireReviewedDatasetId(options.environment.FITNESS_REVIEWED_DATASET_ID);
  const model = options.createModel(providerId);
  const rawRepository = new CloudBasePlanningRepository(options.database);
  const repository = createAccountDeletionGuardedRepository(rawRepository);
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const planning = createMealPlanRecalculationService({
    repository,
    providers: createCloudRuntimeAssistantMealPlanningProviders({
      database: options.database,
      datasetId,
      now
    }),
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
    FITNESS_LLM_PROVIDER_ID: process.env.FITNESS_LLM_PROVIDER_ID,
    FITNESS_LLM_MODEL: process.env.FITNESS_LLM_MODEL,
    FITNESS_REVIEWED_DATASET_ID: process.env.FITNESS_REVIEWED_DATASET_ID
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
