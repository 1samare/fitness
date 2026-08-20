import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PageOptions {
  onOpenPrivacy(): void;
  onOpenDataRights(): void;
}

let registeredPage: PageOptions | undefined;
const navigations: string[] = [];

beforeEach(async () => {
  registeredPage = undefined;
  navigations.length = 0;
  vi.resetModules();
  vi.stubGlobal('Page', (options: PageOptions) => { registeredPage = options; });
  vi.stubGlobal('wx', {
    navigateTo: ({ url }: { readonly url: string }) => { navigations.push(url); }
  });
  await import('./index');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('privacy and personal-data navigation', () => {
  it('opens the fixed pages from planning setup', () => {
    if (registeredPage === undefined) throw new Error('Page was not registered');
    registeredPage.onOpenPrivacy();
    registeredPage.onOpenDataRights();
    expect(navigations).toEqual(['/pages/privacy/index', '/pages/data-rights/index']);
  });

  it('keeps both entry points discoverable from every existing main page', async () => {
    const pages = ['planning-setup', 'planning-preview', 'meal-execution', 'ingredient-photo', 'assistant'];
    for (const page of pages) {
      const [controller, template] = await Promise.all([
        readFile(new URL(`../${page}/index.ts`, import.meta.url), 'utf8'),
        readFile(new URL(`../${page}/index.wxml`, import.meta.url), 'utf8')
      ]);
      expect(controller, `${page} privacy controller`).toContain("'/pages/privacy/index'");
      expect(controller, `${page} data-rights controller`).toContain("'/pages/data-rights/index'");
      expect(template, `${page} privacy binding`).toContain('bindtap="onOpenPrivacy"');
      expect(template, `${page} data-rights binding`).toContain('bindtap="onOpenDataRights"');
    }
  });
});
