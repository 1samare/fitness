import type { PlanningApiResponse, PublicIngredientPhoto } from '@fitness/contracts';
import { planningApiClient } from '../../services/planning-api';
import {
  buildConfirmIngredientCommand,
  buildCreateIngredientPhotoUploadCommand,
  buildRecognizeIngredientPhotoCommand,
  buildRegisterIngredientPhotoUploadCommand
} from './ingredient-photo-form';
import {
  parsePendingIngredientPhotoCommand,
  pendingIngredientPhotoCommandStorageKey,
  selectPendingIngredientPhotoCommand,
  type IngredientPhotoAction,
  type PendingIngredientPhotoCommand,
  type PendingIngredientPhotoDraft
} from './pending-command';
import {
  createIngredientPhotoViewModel,
  selectIngredientCandidate,
  type IngredientCandidateDisplay
} from './view-model';

interface SelectedLocalFile {
  readonly path: string;
  readonly size: number;
  readonly mediaType: 'image/jpeg' | 'image/png';
}

interface PageData {
  localPreviewPath: string;
  selectedMediaType: '' | 'image/jpeg' | 'image/png';
  photoId: string;
  photoRevision: number;
  expectedInventoryVersion: number;
  latestIngredientPhotoVersion: number;
  candidates: readonly IngredientCandidateDisplay[];
  selectedCandidateId: string | null;
  showGramsInput: boolean;
  gramsText: string;
  choosing: boolean;
  uploading: boolean;
  recognizing: boolean;
  confirming: boolean;
  canUpload: boolean;
  canRecognize: boolean;
  errorMessage: string;
  statusMessage: string;
  successMessage: string;
}

interface TextValueEvent { readonly detail: { readonly value: string } }

interface PageActions {
  onLoad(): Promise<void>;
  onUnload(): void;
  onChoosePhoto(): Promise<void>;
  onUploadPhoto(): Promise<void>;
  onRecognizePhoto(): Promise<void>;
  onCandidateChange(event: TextValueEvent): void;
  onGramsInput(event: TextValueEvent): void;
  onConfirmCandidate(): Promise<void>;
  onManualEntry(): void;
}

let selectedLocalFile: SelectedLocalFile | null = null;

const photoActions: readonly IngredientPhotoAction[] = [
  'createIngredientPhotoUpload',
  'registerIngredientPhotoUpload',
  'recognizeIngredientPhoto',
  'confirmIngredientCandidate'
];

function nextIdempotencyKey(action: IngredientPhotoAction): string {
  return `${action}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}

function storedPending(action: IngredientPhotoAction): PendingIngredientPhotoCommand | undefined {
  return parsePendingIngredientPhotoCommand(
    wx.getStorageSync(pendingIngredientPhotoCommandStorageKey(action))
  );
}

function selectAndStorePending(command: PendingIngredientPhotoDraft): PendingIngredientPhotoCommand {
  const storageKey = pendingIngredientPhotoCommandStorageKey(command.action);
  const selected = selectPendingIngredientPhotoCommand({
    command,
    pending: storedPending(command.action),
    nextKey: () => nextIdempotencyKey(command.action)
  });
  wx.setStorageSync(storageKey, selected.pending);
  return selected.pending;
}

function clearPending(action: IngredientPhotoAction): void {
  wx.removeStorageSync(pendingIngredientPhotoCommandStorageKey(action));
}

function clearAllPending(): void {
  for (const action of photoActions) clearPending(action);
}

function photoFromResponse(
  response: PlanningApiResponse,
  expectedKind:
    | 'ingredient_photo_upload_created'
    | 'ingredient_photo_upload_registered'
    | 'ingredient_photo_recognized'
    | 'ingredient_candidate_confirmed'
): PublicIngredientPhoto | undefined {
  return response.success && response.data.kind === expectedKind
    ? response.data.photo
    : undefined;
}

function responseError(response: PlanningApiResponse): string {
  return response.success
    ? '照片服务返回了不匹配的结果，请重新选择图片。'
    : response.error.message;
}

function mediaTypeFromPath(path: string): 'image/jpeg' | 'image/png' | undefined {
  const normalized = path.toLowerCase().split('?')[0] ?? '';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.png')) return 'image/png';
  return undefined;
}

function chooseSingleImage(): Promise<SelectedLocalFile> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success(result) {
        const selected = result.tempFiles[0];
        const mediaType = selected === undefined
          ? undefined
          : mediaTypeFromPath(selected.tempFilePath);
        if (selected === undefined || mediaType === undefined) {
          reject(new Error('请选择 JPEG 或 PNG 图片。'));
          return;
        }
        if (!Number.isSafeInteger(selected.size) || selected.size <= 0) {
          reject(new Error('无法读取图片大小，请重新选择。'));
          return;
        }
        if (selected.size > 10 * 1024 * 1024) {
          reject(new Error('图片不能超过 10 MiB，请压缩后重试。'));
          return;
        }
        resolve({ path: selected.tempFilePath, size: selected.size, mediaType });
      },
      fail() { reject(new Error('未选择图片，你仍可手动录入食材。')); }
    });
  });
}

function uploadPrivateFile(cloudPath: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success(result) {
        if (typeof result.fileID !== 'string' || result.fileID.length === 0) {
          reject(new Error('图片上传结果无效，请重新选择图片。'));
          return;
        }
        resolve(result.fileID);
      },
      fail() { reject(new Error('图片上传失败，请重试或手动录入食材。')); }
    });
  });
}

function restoredSelection(
  photo: PublicIngredientPhoto,
  pending: PendingIngredientPhotoCommand | undefined
): { readonly candidateId: string | null; readonly gramsText: string } {
  if (
    pending?.action !== 'confirmIngredientCandidate'
    || pending.photoId !== photo.photoId
    || pending.candidateId === null
    || pending.confirmedGrams === null
    || !photo.candidates.some((candidate) => candidate.id === pending.candidateId)
  ) return { candidateId: null, gramsText: '' };
  return { candidateId: pending.candidateId, gramsText: String(pending.confirmedGrams) };
}

Page<PageData, PageActions>({
  data: {
    localPreviewPath: '',
    selectedMediaType: '',
    photoId: '',
    photoRevision: 0,
    expectedInventoryVersion: 0,
    latestIngredientPhotoVersion: 0,
    candidates: [],
    selectedCandidateId: null,
    showGramsInput: false,
    gramsText: '',
    choosing: false,
    uploading: false,
    recognizing: false,
    confirming: false,
    canUpload: false,
    canRecognize: false,
    errorMessage: '',
    statusMessage: '',
    successMessage: ''
  },

  async onLoad() {
    this.setData({ errorMessage: '', statusMessage: '正在恢复照片确认进度…' });
    try {
      const response = await planningApiClient.call({ action: 'getCurrentContext' });
      if (!response.success || response.data.kind !== 'current_context') {
        this.setData({ errorMessage: responseError(response), statusMessage: '' });
        return;
      }
      const photo = response.data.ingredientPhoto;
      const common = {
        latestIngredientPhotoVersion: response.data.latestVersions.ingredientPhoto,
        expectedInventoryVersion: response.data.latestVersions.inventory,
        statusMessage: ''
      };
      if (photo === null) {
        this.setData(common);
        return;
      }
      if (photo.workflowStatus === 'recognized') {
        const initial = createIngredientPhotoViewModel(photo);
        const recovered = restoredSelection(
          photo,
          storedPending('confirmIngredientCandidate')
        );
        const viewModel = recovered.candidateId === null
          ? initial
          : selectIngredientCandidate(initial, recovered.candidateId);
        this.setData({
          ...common,
          photoId: viewModel.photoId,
          photoRevision: viewModel.photoRevision,
          candidates: viewModel.candidates,
          selectedCandidateId: viewModel.selectedCandidateId,
          showGramsInput: viewModel.showGramsInput,
          gramsText: recovered.gramsText,
          canRecognize: false
        });
        return;
      }
      this.setData({
        ...common,
        photoId: photo.photoId,
        photoRevision: photo.revision,
        canRecognize: photo.workflowStatus === 'uploaded'
          || photo.workflowStatus === 'recognition_failed',
        errorMessage: photo.workflowStatus === 'recognition_failed'
          ? '上次识别没有支持的候选，请重试识别或手动录入食材。'
          : '',
        successMessage: photo.workflowStatus === 'confirmed'
          ? '该食材已确认写入库存。餐单与营养目标尚未自动变更。'
          : ''
      });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '无法恢复照片进度。',
        statusMessage: ''
      });
    }
  },

  onUnload() {
    selectedLocalFile = null;
    this.setData({ localPreviewPath: '', selectedMediaType: '', canUpload: false });
  },

  async onChoosePhoto() {
    if (this.data.choosing || this.data.uploading) return;
    clearAllPending();
    selectedLocalFile = null;
    this.setData({
      choosing: true,
      localPreviewPath: '',
      selectedMediaType: '',
      canUpload: false,
      canRecognize: false,
      candidates: [],
      selectedCandidateId: null,
      showGramsInput: false,
      gramsText: '',
      errorMessage: '',
      statusMessage: '',
      successMessage: ''
    });
    try {
      const selected = await chooseSingleImage();
      selectedLocalFile = selected;
      this.setData({
        localPreviewPath: selected.path,
        selectedMediaType: selected.mediaType,
        canUpload: true,
        statusMessage: '图片只在本页内存中预览，上传前请确认。'
      });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '图片选择失败。'
      });
    } finally {
      this.setData({ choosing: false });
    }
  },

  async onUploadPhoto() {
    if (this.data.uploading || selectedLocalFile === null) {
      if (selectedLocalFile === null) this.setData({ errorMessage: '请先选择一张图片。' });
      return;
    }
    const localFile = selectedLocalFile;
    let privateFileId: string | null = null;
    this.setData({ uploading: true, errorMessage: '', statusMessage: '正在创建私有上传会话…' });
    try {
      const createPending = selectAndStorePending({
        action: 'createIngredientPhotoUpload',
        expectedVersion: this.data.latestIngredientPhotoVersion,
        photoId: null,
        candidateId: null,
        expectedInventoryVersion: null,
        confirmedGrams: null
      });
      const created = await planningApiClient.call(buildCreateIngredientPhotoUploadCommand({
        mediaType: localFile.mediaType,
        expectedVersion: createPending.expectedVersion,
        idempotencyKey: createPending.idempotencyKey
      }));
      const createdPhoto = photoFromResponse(created, 'ingredient_photo_upload_created');
      if (createdPhoto === undefined || !created.success || created.data.kind !== 'ingredient_photo_upload_created') {
        throw new Error(responseError(created));
      }
      clearPending('createIngredientPhotoUpload');
      this.setData({ latestIngredientPhotoVersion: createPending.expectedVersion + 1 });
      this.setData({ statusMessage: '正在上传到私有云存储…' });
      privateFileId = await uploadPrivateFile(created.data.cloudPath, localFile.path);

      const registerPending = selectAndStorePending({
        action: 'registerIngredientPhotoUpload',
        expectedVersion: createdPhoto.revision,
        photoId: createdPhoto.photoId,
        candidateId: null,
        expectedInventoryVersion: null,
        confirmedGrams: null
      });
      this.setData({ statusMessage: '正在登记并校验私有图片…' });
      const registered = await planningApiClient.call(buildRegisterIngredientPhotoUploadCommand({
        photoId: createdPhoto.photoId,
        privateFileId,
        photoRevision: registerPending.expectedVersion,
        idempotencyKey: registerPending.idempotencyKey
      }));
      const registeredPhoto = photoFromResponse(
        registered,
        'ingredient_photo_upload_registered'
      );
      if (registeredPhoto === undefined) throw new Error(responseError(registered));
      clearPending('registerIngredientPhotoUpload');
      this.setData({
        photoId: registeredPhoto.photoId,
        photoRevision: registeredPhoto.revision,
        canUpload: false,
        canRecognize: true,
        statusMessage: '图片已登记。请单独发起识别。'
      });
    } catch (error: unknown) {
      this.setData({
        canUpload: false,
        canRecognize: false,
        statusMessage: '',
        errorMessage: error instanceof Error ? error.message : '图片上传或登记失败。'
      });
    } finally {
      privateFileId = null;
      selectedLocalFile = null;
      this.setData({ uploading: false, localPreviewPath: '', selectedMediaType: '' });
    }
  },

  async onRecognizePhoto() {
    if (this.data.recognizing || !this.data.canRecognize) return;
    this.setData({ recognizing: true, errorMessage: '', statusMessage: '正在识别候选食材…' });
    try {
      const pending = selectAndStorePending({
        action: 'recognizeIngredientPhoto',
        expectedVersion: this.data.photoRevision,
        photoId: this.data.photoId,
        candidateId: null,
        expectedInventoryVersion: null,
        confirmedGrams: null
      });
      const response = await planningApiClient.call(buildRecognizeIngredientPhotoCommand({
        photoId: pending.photoId ?? '',
        photoRevision: pending.expectedVersion,
        idempotencyKey: pending.idempotencyKey
      }));
      const photo = photoFromResponse(response, 'ingredient_photo_recognized');
      if (photo === undefined) throw new Error(responseError(response));
      clearPending('recognizeIngredientPhoto');
      if (photo.workflowStatus === 'recognition_failed' || photo.candidates.length === 0) {
        this.setData({
          photoId: photo.photoId,
          photoRevision: photo.revision,
          candidates: [],
          selectedCandidateId: null,
          showGramsInput: false,
          gramsText: '',
          canRecognize: true,
          statusMessage: '',
          errorMessage: '没有识别到支持的候选，请重试识别或手动录入食材。'
        });
        return;
      }
      const viewModel = createIngredientPhotoViewModel(photo);
      this.setData({
        photoId: viewModel.photoId,
        photoRevision: viewModel.photoRevision,
        candidates: viewModel.candidates,
        selectedCandidateId: null,
        showGramsInput: false,
        gramsText: '',
        canRecognize: false,
        statusMessage: '识别结果仅为候选，请选择后确认。'
      });
    } catch (error: unknown) {
      this.setData({
        statusMessage: '',
        errorMessage: error instanceof Error ? error.message : '图片识别失败。'
      });
    } finally {
      this.setData({ recognizing: false });
    }
  },

  onCandidateChange(event) {
    try {
      const selected = selectIngredientCandidate({
        photoId: this.data.photoId,
        photoRevision: this.data.photoRevision,
        candidates: this.data.candidates,
        selectedCandidateId: null,
        showGramsInput: false
      }, event.detail.value);
      clearPending('confirmIngredientCandidate');
      this.setData({
        selectedCandidateId: selected.selectedCandidateId,
        showGramsInput: true,
        gramsText: '',
        errorMessage: '',
        successMessage: ''
      });
    } catch (error: unknown) {
      this.setData({ errorMessage: error instanceof Error ? error.message : '候选选择失败。' });
    }
  },

  onGramsInput(event) {
    clearPending('confirmIngredientCandidate');
    this.setData({ gramsText: event.detail.value, errorMessage: '', successMessage: '' });
  },

  async onConfirmCandidate() {
    if (this.data.confirming) return;
    const provisional = buildConfirmIngredientCommand({
      photoId: this.data.photoId,
      photoRevision: this.data.photoRevision,
      selectedCandidateId: this.data.selectedCandidateId,
      gramsText: this.data.gramsText,
      expectedInventoryVersion: this.data.expectedInventoryVersion,
      idempotencyKey: 'photo-confirm-placeholder'
    });
    if (!provisional.ok) {
      this.setData({
        errorMessage: provisional.reason === 'candidate_required'
          ? '请先明确选择一个候选食材。'
          : '克数须为 1–1000000 的正整数。'
      });
      return;
    }
    const submitted = provisional.request.payload.payload;
    const pending = selectAndStorePending({
      action: 'confirmIngredientCandidate',
      expectedVersion: provisional.request.payload.expectedVersion,
      photoId: submitted.photoId,
      candidateId: submitted.candidateId,
      expectedInventoryVersion: submitted.expectedInventoryVersion,
      confirmedGrams: submitted.confirmedGrams
    });
    if (
      pending.photoId === null
      || pending.candidateId === null
      || pending.expectedInventoryVersion === null
      || pending.confirmedGrams === null
    ) throw new Error('照片确认恢复状态无效');
    const built = buildConfirmIngredientCommand({
      photoId: pending.photoId,
      photoRevision: pending.expectedVersion,
      selectedCandidateId: pending.candidateId,
      gramsText: String(pending.confirmedGrams),
      expectedInventoryVersion: pending.expectedInventoryVersion,
      idempotencyKey: pending.idempotencyKey
    });
    if (!built.ok) throw new Error('照片确认恢复命令无效');

    this.setData({ confirming: true, errorMessage: '', successMessage: '' });
    try {
      const response = await planningApiClient.call(built.request);
      const photo = photoFromResponse(response, 'ingredient_candidate_confirmed');
      if (photo === undefined || !response.success || response.data.kind !== 'ingredient_candidate_confirmed') {
        throw new Error(responseError(response));
      }
      clearPending('confirmIngredientCandidate');
      this.setData({
        photoRevision: photo.revision,
        expectedInventoryVersion: response.data.inventory.version,
        successMessage: '食材已确认写入库存。餐单与营养目标尚未自动变更。',
        statusMessage: '',
        showGramsInput: false
      });
    } catch (error: unknown) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : '确认结果暂不可用，请重试。'
      });
    } finally {
      this.setData({ confirming: false });
    }
  },

  onManualEntry() {
    selectedLocalFile = null;
    void wx.redirectTo({ url: '/pages/meal-execution/index' });
  }
});
