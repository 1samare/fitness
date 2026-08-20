import type { PlanningApiResponse } from '@fitness/contracts';
import { clearAllLocalPrivateState } from '../../services/local-private-state';
import { planningApiClient } from '../../services/planning-api';

type SuccessData = Extract<PlanningApiResponse, { success: true }>['data'];
type PersonalDataSummary = Extract<SuccessData, { kind: 'personal_data_summary' }>;
type PersonalDataExport = Extract<SuccessData, { kind: 'personal_data_export' }>;
type PlanningFailure = Extract<PlanningApiResponse, { success: false }>;

interface TextValueEvent { readonly detail: { readonly value: string } }

interface PageData {
  summary: PersonalDataSummary | null;
  snapshotToken: string;
  loading: boolean;
  exporting: boolean;
  deleting: boolean;
  chineseConfirmation: string;
  technicalConfirmation: string;
  canDelete: boolean;
  deleteIdempotencyKey: string;
  statusMessage: string;
  errorMessage: string;
}

interface PageActions {
  onLoad(): Promise<void>;
  onRefreshSummary(): Promise<void>;
  onChineseConfirmationInput(event: TextValueEvent): void;
  onTechnicalConfirmationInput(event: TextValueEvent): void;
  onCopyExport(): Promise<void>;
  onShareExport(): Promise<void>;
  onDeleteAccount(): Promise<void>;
  onOpenCorrection(): void;
  onOpenPrivacy(): void;
}

interface DataRightsPageContext {
  data: PageData;
  setData(patch: Partial<PageData>): void;
}

const exportFileName = 'fitness-personal-data-export.json';

function nextDeleteIdempotencyKey(): string {
  return `delete-account-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

function fixedRecoveryMessage(error: PlanningFailure['error']): string {
  if (error.code === 'account_deletion_pending' || error.code === 'storage_unavailable') {
    return '账户删除正在处理中，请使用同一删除请求重试。';
  }
  if (error.code === 'personal_data_snapshot_conflict') {
    return '个人数据已变化，请刷新摘要后重试导出或删除。';
  }
  if (error.code === 'account_capacity_exceeded') {
    return '个人数据量超出自助处理范围，请联系隐私支持。';
  }
  return error.message;
}

function confirmationsMatch(chinese: string, technical: string): boolean {
  return chinese === '删除我的账户' && technical === 'DELETE_MY_ACCOUNT';
}

async function refreshSummary(page: DataRightsPageContext): Promise<void> {
  if (page.data.deleting) return;
  page.setData({ loading: true, errorMessage: '', statusMessage: '' });
  try {
    const response = await planningApiClient.call({ action: 'getPersonalDataSummary' });
    if (!response.success) {
      page.setData({ errorMessage: fixedRecoveryMessage(response.error) });
      return;
    }
    if (response.data.kind !== 'personal_data_summary') {
      page.setData({ errorMessage: '个人数据摘要返回了非预期结果，请稍后重试。' });
      return;
    }
    page.setData({
      summary: response.data,
      snapshotToken: response.data.snapshotToken ?? '',
      deleteIdempotencyKey: '',
      statusMessage: response.data.dataExists ? '' : '当前账户没有可导出或删除的数据。'
    });
  } catch (error: unknown) {
    page.setData({
      errorMessage: error instanceof Error ? error.message : '个人数据服务暂时不可用。'
    });
  } finally {
    page.setData({ loading: false });
  }
}

async function fetchExport(page: DataRightsPageContext): Promise<PersonalDataExport | undefined> {
  if (page.data.snapshotToken.length === 0) {
    page.setData({ errorMessage: '请先刷新个人数据摘要。' });
    return undefined;
  }
  const response = await planningApiClient.call({
    action: 'exportPersonalData',
    snapshotToken: page.data.snapshotToken
  });
  if (!response.success) {
    page.setData({ errorMessage: fixedRecoveryMessage(response.error) });
    return undefined;
  }
  if (response.data.kind !== 'personal_data_export') {
    page.setData({ errorMessage: '个人数据导出返回了非预期结果，请稍后重试。' });
    return undefined;
  }
  return response.data;
}

function exportJson(value: PersonalDataExport): string {
  return JSON.stringify(value, null, 2);
}

function copyJson(json: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.setClipboardData({
      data: json,
      success: () => { resolve(); },
      fail: () => { reject(new Error('复制失败，请稍后重试。')); }
    });
  });
}

function writeExportFile(filePath: string, json: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: json,
      encoding: 'utf8',
      success: () => { resolve(); },
      fail: () => { reject(new Error('临时导出文件写入失败，请改用复制。')); }
    });
  });
}

function shareExportFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.shareFileMessage({
      filePath,
      fileName: exportFileName,
      success: () => { resolve(); },
      fail: () => { reject(new Error('文件分享未完成，请改用复制。')); },
      complete: () => {
        wx.getFileSystemManager().unlink({
          filePath,
          fail: () => undefined
        });
      }
    });
  });
}

function confirmDeletion(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '确认永久删除',
      content: '此操作不可撤销。服务端记录、私有照片和本地恢复数据都会删除。',
      confirmText: '永久删除',
      confirmColor: '#b91c1c',
      success: (result) => { resolve(result.confirm); },
      fail: () => { resolve(false); }
    });
  });
}

Page<PageData, PageActions>({
  data: {
    summary: null,
    snapshotToken: '',
    loading: false,
    exporting: false,
    deleting: false,
    chineseConfirmation: '',
    technicalConfirmation: '',
    canDelete: false,
    deleteIdempotencyKey: '',
    statusMessage: '',
    errorMessage: ''
  },

  async onLoad() {
    await refreshSummary(this);
  },

  async onRefreshSummary() {
    await refreshSummary(this);
  },

  onChineseConfirmationInput(event) {
    const chineseConfirmation = event.detail.value;
    this.setData({
      chineseConfirmation,
      canDelete: confirmationsMatch(chineseConfirmation, this.data.technicalConfirmation)
    });
  },

  onTechnicalConfirmationInput(event) {
    const technicalConfirmation = event.detail.value;
    this.setData({
      technicalConfirmation,
      canDelete: confirmationsMatch(this.data.chineseConfirmation, technicalConfirmation)
    });
  },

  async onCopyExport() {
    if (this.data.loading || this.data.exporting || this.data.deleting) return;
    this.setData({ exporting: true, errorMessage: '', statusMessage: '' });
    try {
      const data = await fetchExport(this);
      if (data === undefined) return;
      await copyJson(exportJson(data));
      this.setData({ statusMessage: '个人数据 JSON 已复制到剪贴板。' });
    } catch (error: unknown) {
      this.setData({ errorMessage: error instanceof Error ? error.message : '导出复制失败。' });
    } finally {
      this.setData({ exporting: false });
    }
  },

  async onShareExport() {
    if (this.data.loading || this.data.exporting || this.data.deleting) return;
    this.setData({ exporting: true, errorMessage: '', statusMessage: '' });
    try {
      const data = await fetchExport(this);
      if (data === undefined) return;
      const json = exportJson(data);
      if (typeof wx.shareFileMessage !== 'function') {
        await copyJson(json);
        this.setData({ statusMessage: '当前微信版本不支持文件分享，已复制个人数据 JSON。' });
        return;
      }
      const filePath = `${wx.env.USER_DATA_PATH}/${exportFileName}`;
      await writeExportFile(filePath, json);
      await shareExportFile(filePath);
      this.setData({ statusMessage: '临时文件已发起分享，并已安排立即清理。' });
    } catch (error: unknown) {
      this.setData({ errorMessage: error instanceof Error ? error.message : '导出分享失败。' });
    } finally {
      this.setData({ exporting: false });
    }
  },

  async onDeleteAccount() {
    if (
      this.data.loading
      || this.data.exporting
      || this.data.deleting
      || !confirmationsMatch(
        this.data.chineseConfirmation,
        this.data.technicalConfirmation
      )
      || this.data.snapshotToken.length === 0
    ) return;
    if (!await confirmDeletion()) return;

    const idempotencyKey = this.data.deleteIdempotencyKey || nextDeleteIdempotencyKey();
    this.setData({
      deleting: true,
      deleteIdempotencyKey: idempotencyKey,
      errorMessage: '',
      statusMessage: ''
    });
    try {
      const response = await planningApiClient.call({
        action: 'deleteAccount',
        payload: {
          snapshotToken: this.data.snapshotToken,
          idempotencyKey,
          confirmation: 'DELETE_MY_ACCOUNT'
        }
      });
      if (!response.success) {
        this.setData({ errorMessage: fixedRecoveryMessage(response.error) });
        if (response.error.code === 'personal_data_snapshot_conflict') {
          this.setData({ deleteIdempotencyKey: '' });
        }
        return;
      }
      if (
        response.data.kind !== 'account_deleted'
        && response.data.kind !== 'account_already_absent'
      ) {
        this.setData({ errorMessage: '账户删除返回了非预期结果，请保持本页并重试。' });
        return;
      }
      clearAllLocalPrivateState();
      void wx.reLaunch({ url: '/pages/planning-setup/index' });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error
          ? `${error.message} 请使用同一删除请求重试。`
          : '账户删除暂未完成，请使用同一删除请求重试。'
      });
    } finally {
      this.setData({ deleting: false });
    }
  },

  onOpenCorrection() {
    void wx.navigateTo({ url: '/pages/planning-setup/index' });
  },

  onOpenPrivacy() {
    void wx.navigateTo({ url: '/pages/privacy/index' });
  }
});
