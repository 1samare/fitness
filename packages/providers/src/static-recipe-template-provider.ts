import { recipeTemplateVersionSchema } from '@fitness/contracts';
import type { RecipeTemplateProvider, RecipeTemplateVersion } from '@fitness/domain';
import { assertUniqueRecordIds } from './reviewed-records';

export class InvalidRecipeTemplateError extends Error {
  public readonly code = 'invalid_recipe_template' as const;

  public constructor() {
    super('Recipe template failed runtime validation');
    this.name = 'InvalidRecipeTemplateError';
  }
}

export class RecipeTemplateUnavailableError extends Error {
  public readonly code = 'recipe_template_unavailable' as const;

  public constructor(public readonly versionId: string) {
    super(`No approved recipe template is available for ${versionId}`);
    this.name = 'RecipeTemplateUnavailableError';
  }
}

export interface StaticRecipeTemplateProviderOptions {
  readonly mode: 'production' | 'test';
  readonly templates: readonly unknown[];
}

export class StaticRecipeTemplateProvider implements RecipeTemplateProvider {
  private readonly mode: StaticRecipeTemplateProviderOptions['mode'];
  private readonly templates: ReadonlyMap<string, RecipeTemplateVersion>;

  public constructor(options: StaticRecipeTemplateProviderOptions) {
    const templates: RecipeTemplateVersion[] = [];
    for (const value of options.templates) {
      const parsed = recipeTemplateVersionSchema.safeParse(value);
      if (!parsed.success) throw new InvalidRecipeTemplateError();
      templates.push(parsed.data);
    }
    assertUniqueRecordIds(templates);
    this.mode = options.mode;
    this.templates = new Map(templates.map((template) => [template.id, template]));
  }

  public getByVersionId(versionId: string): Promise<RecipeTemplateVersion> {
    const template = this.templates.get(versionId);
    if (
      template === undefined
      || (this.mode === 'production' && template.qualityStatus !== 'reviewed')
    ) {
      return Promise.reject(new RecipeTemplateUnavailableError(versionId));
    }
    return Promise.resolve(structuredClone(template));
  }
}
