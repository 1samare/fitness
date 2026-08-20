import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PageOptions {
  readonly data: Record<string, unknown>;
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

describe('privacy page', () => {
  it('renders release identity, collection limits, content origins, retention, safety, and rights', async () => {
    const [wxml, pageJson] = await Promise.all([
      readFile(new URL('./index.wxml', import.meta.url), 'utf8'),
      readFile(new URL('./index.json', import.meta.url), 'utf8')
    ]);
    expect(registeredPage?.data).toMatchObject({
      operatorName: '仅限本地开发，不得发布',
      privacyContact: 'local-only@invalid.example',
      privacyNoticeVersion: 'local-dev'
    });
    expect(wxml).toContain('处理目的');
    expect(wxml).toContain('最小化收集');
    expect(wxml).toContain('用户提供：身体档案、目标、训练安排、库存、确认后的照片候选与执行反馈。');
    expect(wxml).toContain('AI 辅助：受限助手表述与食材候选；候选必须由用户确认。');
    expect(wxml).toContain('确定性估算：热量、训练消耗、营养目标和克数；不是医疗建议。');
    expect(wxml).toContain('24 小时内删除');
    expect(wxml).toContain('不构成医疗建议');
    expect(wxml).toContain('查看、复制、导出、更正和删除');
    expect(wxml).toContain('bindtap="onOpenDataRights"');
    expect(JSON.parse(pageJson)).toMatchObject({ navigationBarTitleText: '隐私说明' });
  });

  it('opens the fixed personal data rights page', () => {
    if (registeredPage === undefined) throw new Error('Page was not registered');
    registeredPage.onOpenDataRights();
    expect(navigations).toEqual(['/pages/data-rights/index']);
  });
});
