import {
  dailyMenuCatalogVersionSchema,
  dailyMenuTemplateVersionSchema
} from '@fitness/contracts';
import type {
  DailyMenuCatalogProvider,
  DailyMenuCatalogVersion,
  DailyMenuTemplateVersion
} from '@fitness/domain';
import { assertUniqueRecordIds } from './reviewed-records';

export class InvalidDailyMenuCatalogError extends Error {
  public readonly code = 'invalid_daily_menu_catalog' as const;

  public constructor() {
    super('Daily menu catalog failed runtime validation');
    this.name = 'InvalidDailyMenuCatalogError';
  }
}

export class DailyMenuCatalogUnavailableError extends Error {
  public readonly code = 'daily_menu_catalog_unavailable' as const;

  public constructor() {
    super('No approved daily menu catalog is available');
    this.name = 'DailyMenuCatalogUnavailableError';
  }
}

export class DailyMenuTemplateUnavailableError extends Error {
  public readonly code = 'daily_menu_template_unavailable' as const;

  public constructor(public readonly versionId: string) {
    super(`No approved daily menu template is available for ${versionId}`);
    this.name = 'DailyMenuTemplateUnavailableError';
  }
}

export interface StaticDailyMenuCatalogProviderOptions {
  readonly mode: 'production' | 'test';
  readonly catalog: unknown;
  readonly menus: readonly unknown[];
}

export class StaticDailyMenuCatalogProvider implements DailyMenuCatalogProvider {
  private readonly mode: StaticDailyMenuCatalogProviderOptions['mode'];
  private readonly catalog: DailyMenuCatalogVersion;
  private readonly menus: ReadonlyMap<string, DailyMenuTemplateVersion>;

  public constructor(options: StaticDailyMenuCatalogProviderOptions) {
    const catalog = dailyMenuCatalogVersionSchema.safeParse(options.catalog);
    if (!catalog.success) throw new InvalidDailyMenuCatalogError();
    const menus: DailyMenuTemplateVersion[] = [];
    for (const value of options.menus) {
      const menu = dailyMenuTemplateVersionSchema.safeParse(value);
      if (!menu.success) throw new InvalidDailyMenuCatalogError();
      menus.push(menu.data);
    }
    assertUniqueRecordIds(menus);
    const menuIds = new Set(menus.map((menu) => menu.id));
    if (catalog.data.dailyMenuTemplateVersionIds.some((id) => !menuIds.has(id))) {
      throw new InvalidDailyMenuCatalogError();
    }
    this.mode = options.mode;
    this.catalog = catalog.data;
    this.menus = new Map(menus.map((menu) => [menu.id, menu]));
  }

  public getActiveCatalog(): Promise<DailyMenuCatalogVersion> {
    if (this.mode === 'production' && this.catalog.qualityStatus !== 'reviewed') {
      return Promise.reject(new DailyMenuCatalogUnavailableError());
    }
    return Promise.resolve(structuredClone(this.catalog));
  }

  public getMenuByVersionId(versionId: string): Promise<DailyMenuTemplateVersion> {
    const menu = this.menus.get(versionId);
    if (menu === undefined || (this.mode === 'production' && menu.qualityStatus !== 'reviewed')) {
      return Promise.reject(new DailyMenuTemplateUnavailableError(versionId));
    }
    return Promise.resolve(structuredClone(menu));
  }
}
