import { readFile } from 'node:fs/promises';
import type { PlanningApiRequest, PlanningApiResponse } from '@fitness/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TextEvent { readonly detail: { readonly value: string } }
interface PageOptions {
  readonly data: Record<string, unknown>;
  onLoad(): Promise<void>;
  onChineseConfirmationInput(event: TextEvent): void;
  onTechnicalConfirmationInput(event: TextEvent): void;
  onCopyExport(): Promise<void>;
  onShareExport(): Promise<void>;
  onDeleteAccount(): Promise<void>;
  onOpenCorrection(): void;
}
interface PageInstance extends PageOptions {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
}

const summaryToken = 'a'.repeat(64);
const summary: PlanningApiResponse = {
  success: true,
  data: {
    kind: 'personal_data_summary',
    dataExists: true,
    snapshotToken: summaryToken,
    deletionStatus: 'none',
    capacityStatus: 'within_limit',
    activeVersions: { bodyProfile: 1, goal: 1, trainingPlan: 2, inventory: 1, mealPlan: 3 },
    counts: {
      bodyProfileVersions: 1,
      goalVersions: 1,
      trainingPlanVersions: 2,
      dailyTargetVersions: 28,
      inventoryVersions: 1,
      mealPlanVersions: 3,
      ingredientPhotoRecords: 1,
      assistantMessages: 2
    }
  }
};
const exported: PlanningApiResponse = {
  success: true,
  data: {
    kind: 'personal_data_export',
    schemaVersion: 'personal-data-export-v1',
    snapshotToken: summaryToken,
    exportedAt: '2026-08-20T00:00:00.000Z',
    notice: '包含 AI 辅助生成内容与确定性估算；仅供健康成年人健身规划参考，不构成医疗建议。',
    provenance: {
      policyVersions: ['calculation-policy-v2'],
      reviewedDataVersionReferences: ['2024-adult-compendium']
    },
    records: [{
      category: 'assistant_message',
      contentOrigin: 'ai_assisted',
      recordVersion: null,
      recordedAt: '2026-08-20T00:00:00.000Z',
      data: { role: 'assistant', content: '测试内容' }
    }]
  }
};

const planningCalls: PlanningApiRequest[] = [];
const planningResponses: PlanningApiResponse[] = [];
const clipboardValues: string[] = [];
const sharedPaths: string[] = [];
const unlinkedPaths: string[] = [];
const navigations: string[] = [];
const clearStorageSync = vi.fn();
const reLaunch = vi.fn(({ url }: { readonly url: string }) => { navigations.push(url); });
let registeredPage: PageOptions | undefined;

vi.mock('../../services/planning-api', () => ({
  planningApiClient: {
    call(request: PlanningApiRequest) {
      planningCalls.push(request);
      const response = planningResponses.shift();
      return response === undefined
        ? Promise.reject(new Error('Missing planning response'))
        : Promise.resolve(response);
    }
  }
}));

function pageInstance(): PageInstance {
  if (registeredPage === undefined) throw new Error('Page was not registered');
  return {
    ...registeredPage,
    data: { ...registeredPage.data },
    setData(patch) { Object.assign(this.data, patch); }
  };
}

beforeEach(async () => {
  planningCalls.length = 0;
  planningResponses.length = 0;
  clipboardValues.length = 0;
  sharedPaths.length = 0;
  unlinkedPaths.length = 0;
  navigations.length = 0;
  clearStorageSync.mockClear();
  reLaunch.mockClear();
  registeredPage = undefined;
  vi.resetModules();
  vi.stubGlobal('Page', (options: PageOptions) => { registeredPage = options; });
  vi.stubGlobal('wx', {
    env: { USER_DATA_PATH: '/private-user-data' },
    clearStorageSync,
    reLaunch,
    navigateTo: ({ url }: { readonly url: string }) => { navigations.push(url); },
    showModal: ({ success }: { readonly success?: ((value: { confirm: boolean }) => void) }) => {
      success?.({ confirm: true });
    },
    setClipboardData: ({ data, success }: {
      readonly data: string;
      readonly success?: (() => void);
    }) => {
      clipboardValues.push(data);
      success?.();
    },
    getFileSystemManager: () => ({
      writeFile: ({ filePath, success }: {
        readonly filePath: string;
        readonly success?: (() => void);
      }) => {
        sharedPaths.push(filePath);
        success?.();
      },
      unlink: ({ filePath, complete }: {
        readonly filePath: string;
        readonly complete?: (() => void);
      }) => {
        unlinkedPaths.push(filePath);
        complete?.();
      }
    }),
    shareFileMessage: ({ filePath, success, complete }: {
      readonly filePath: string;
      readonly success?: (() => void);
      readonly complete?: (() => void);
    }) => {
      expect(filePath).toBe('/private-user-data/fitness-personal-data-export.json');
      success?.();
      complete?.();
    }
  });
  await import('./index');
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('personal data rights page', () => {
  it('loads the summary, exports the loaded snapshot, copies strict JSON, and shares a temporary file', async () => {
    planningResponses.push(summary, exported, exported);
    const page = pageInstance();

    await page.onLoad.call(page);
    await page.onCopyExport.call(page);
    await page.onShareExport.call(page);

    expect(planningCalls).toEqual([
      { action: 'getPersonalDataSummary' },
      { action: 'exportPersonalData', snapshotToken: summaryToken },
      { action: 'exportPersonalData', snapshotToken: summaryToken }
    ]);
    expect(JSON.parse(clipboardValues[0] ?? '')).toEqual(exported.data);
    expect(sharedPaths).toEqual(['/private-user-data/fitness-personal-data-export.json']);
    expect(unlinkedPaths).toEqual(['/private-user-data/fitness-personal-data-export.json']);
    expect(page.data.statusMessage).toContain('临时文件');
  });

  it('falls back to clipboard when file sharing is unsupported', async () => {
    const wxValue = wx;
    Object.assign(wxValue, { shareFileMessage: undefined });
    planningResponses.push(summary, exported);
    const page = pageInstance();

    await page.onLoad.call(page);
    await page.onShareExport.call(page);

    expect(clipboardValues).toHaveLength(1);
    expect(sharedPaths).toHaveLength(0);
    expect(page.data.statusMessage).toContain('不支持文件分享，已复制');
  });

  it.each(['account_deleted', 'account_already_absent'] as const)(
    'requires both exact phrases and clears all local state before redirecting on %s',
    async (kind) => {
      planningResponses.push(summary, {
        success: true,
        data: kind === 'account_deleted'
          ? { kind, deletedPrivateFileCount: 1 }
          : { kind, deletedPrivateFileCount: 0 }
      });
      const page = pageInstance();
      await page.onLoad.call(page);
      expect(page.data.canDelete).toBe(false);

      page.onChineseConfirmationInput.call(page, { detail: { value: '删除我的账户' } });
      expect(page.data.canDelete).toBe(false);
      page.onTechnicalConfirmationInput.call(page, { detail: { value: 'DELETE_MY_ACCOUNT' } });
      expect(page.data.canDelete).toBe(true);
      await page.onDeleteAccount.call(page);

      const deletionCall = planningCalls.at(-1);
      if (deletionCall?.action !== 'deleteAccount') {
        throw new Error('Expected deleteAccount request');
      }
      expect(deletionCall.payload.snapshotToken).toBe(summaryToken);
      expect(deletionCall.payload.confirmation).toBe('DELETE_MY_ACCOUNT');
      expect(deletionCall.payload.idempotencyKey).toMatch(/^delete-account-/);
      expect(clearStorageSync).toHaveBeenCalledOnce();
      expect(reLaunch).toHaveBeenCalledWith({ url: '/pages/planning-setup/index' });
      expect(clearStorageSync.mock.invocationCallOrder[0])
        .toBeLessThan(reLaunch.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
    }
  );

  it.each([
    ['account_deletion_pending', '账户删除正在处理中，请使用同一删除请求重试。'],
    ['account_capacity_exceeded', '个人数据量超出自助处理范围，请联系隐私支持。']
  ] as const)('shows fixed recovery copy for %s summary failures', async (code, message) => {
    planningResponses.push({ success: false, error: { code, message: 'unsafe supplier detail' } });
    const page = pageInstance();
    await page.onLoad.call(page);
    expect(page.data.errorMessage).toBe(message);
  });

  it('shows fixed snapshot-conflict recovery and links correction to versioned planning setup', async () => {
    planningResponses.push(summary, {
      success: false,
      error: { code: 'personal_data_snapshot_conflict', message: 'unsafe detail' }
    });
    const page = pageInstance();
    await page.onLoad.call(page);
    await page.onCopyExport.call(page);
    page.onOpenCorrection.call(page);

    expect(page.data.errorMessage).toBe('个人数据已变化，请刷新摘要后重试导出或删除。');
    expect(navigations).toContain('/pages/planning-setup/index');
  });

  it('renders explicit irreversible deletion controls and correction guidance', async () => {
    const wxml = await readFile(new URL('./index.wxml', import.meta.url), 'utf8');
    expect(wxml).toContain('删除我的账户');
    expect(wxml).toContain('DELETE_MY_ACCOUNT');
    expect(wxml).toContain('disabled="{{!canDelete || deleting || loading}}"');
    expect(wxml).toContain('此操作不可撤销');
    expect(wxml).toContain('更正会创建新版本，不改写历史事实');
    expect(wxml).toContain('bindtap="onOpenCorrection"');
  });
});
