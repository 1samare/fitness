import { randomUUID } from 'node:crypto';
import type {
  AssistantLanguageModelInput,
  AssistantLanguageModelProvider,
  FitnessAssistantAgent,
  FitnessAssistantAgentDependencies
} from '@fitness/agent';
import {
  createAccountDeletionGuardedRepository,
  createMealPlanRecalculationService,
  type MealPlanningProviders,
  type PlanningRepository
} from '@fitness/application';
import type { AssistantApiResponse } from '@fitness/contracts';
import { InMemoryPlanningRepository } from '@fitness/persistence';
import {
  ReviewedNutritionCache,
  StaticDailyMenuCatalogProvider,
  StaticRecipeTemplateProvider
} from '@fitness/providers';
import {
  createAssistantApiComposition,
  type TrustedAssistantRequestContext
} from './handler';

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

function lastUserMessage(input: AssistantLanguageModelInput): string {
  return [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

class DeterministicLocalLanguageModel implements AssistantLanguageModelProvider {
  public generateIntent(input: AssistantLanguageModelInput) {
    const message = lastUserMessage(input);
    if (message === '本地烟测：模拟模型不可用') {
      return Promise.reject(new Error('simulated local Provider outage'));
    }
    const dates = Array.from(message.matchAll(/\d{4}-\d{2}-\d{2}/g), (match) => match[0]);
    if (dates.length >= 2) {
      return Promise.resolve({
        rawText: JSON.stringify({
          kind: 'command',
          intent: 'move_training_day',
          evidence: {
            sourceDateText: dates[0],
            targetDateText: dates[1]
          }
        }),
        requestId: input.requestId
      });
    }
    if (message.includes('训练') && dates.length === 1) {
      return Promise.resolve({
        rawText: JSON.stringify({
          kind: 'clarify',
          intent: 'move_training_day',
          missingFields: ['target_date']
        }),
        requestId: input.requestId
      });
    }
    return Promise.resolve({
      rawText: JSON.stringify({ kind: 'reject', reason: 'unsupported_request' }),
      requestId: input.requestId
    });
  }
}

export interface LocalRuntimeAssistantHandlerOptions {
  readonly runtimeMode: 'local';
  readonly now?: (() => string) | undefined;
  readonly nextId?: ((prefix: string) => string) | undefined;
  readonly provider?: AssistantLanguageModelProvider | undefined;
  readonly repository?: PlanningRepository | undefined;
  readonly createAgent?: ((
    dependencies: FitnessAssistantAgentDependencies
  ) => FitnessAssistantAgent) | undefined;
}

export function createRuntimeAssistantHandler(
  options: LocalRuntimeAssistantHandlerOptions
): (
  input: unknown,
  context?: TrustedAssistantRequestContext
) => Promise<AssistantApiResponse> {
  const rawRepository = options.repository ?? new InMemoryPlanningRepository();
  const repository = createAccountDeletionGuardedRepository(rawRepository);
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const planning = createMealPlanRecalculationService({
    repository,
    providers: lazyLocalProviders(),
    now,
    nextId
  });
  return createAssistantApiComposition({
    repository,
    planning,
    provider: options.provider ?? new DeterministicLocalLanguageModel(),
    now,
    nextId,
    ...(options.createAgent === undefined ? {} : { createAgent: options.createAgent })
  });
}
