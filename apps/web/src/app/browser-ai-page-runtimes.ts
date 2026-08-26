import type { AssistantPageRuntime, AssistantPageSnapshot } from './pages/AssistantPage';
import type {
  IngredientPhotoPageRuntime,
  IngredientPhotoPageSnapshot
} from './pages/IngredientPhotoPage';
import type { LocalAssistantRuntime } from '../features/assistant/local-assistant-runtime';
import type {
  LocalImageCandidateRuntime,
  LocalImageCandidateSnapshot
} from '../features/ingredient-photo/local-image-candidate-runtime';

type PlanningRefresh = () => Promise<void>;

function assistantSnapshot(
  conversation: Awaited<ReturnType<LocalAssistantRuntime['initialize']>>,
  notice?: string
): AssistantPageSnapshot {
  return {
    status: notice === undefined ? 'ready' : 'degraded',
    messages: conversation.recentMessages.map((message, index) => ({
      id: `${message.turnId}-${message.role}-${String(index)}`,
      role: message.role,
      text: message.content
    })),
    ...(notice === undefined ? {} : { notice })
  };
}

export function createAssistantPageRuntime(
  runtime: LocalAssistantRuntime,
  refreshPlanning: PlanningRefresh
): AssistantPageRuntime {
  return {
    async initialize() {
      return assistantSnapshot(await runtime.initialize());
    },
    async sendMessage(message) {
      const completed = await runtime.sendMessage(message);
      if (completed.result.kind === 'command_executed') await refreshPlanning();
      return assistantSnapshot(
        completed.conversation,
        completed.result.kind === 'assistant_unavailable' ? completed.result.message : undefined
      );
    }
  };
}

function imageSnapshot(
  snapshot: LocalImageCandidateSnapshot,
  previewUrl: string | undefined,
  notice?: string
): IngredientPhotoPageSnapshot {
  return {
    status: snapshot.status,
    candidates: snapshot.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.canonicalNameZh,
      confidence: candidate.confidence,
      state: candidate.foodState
    })),
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(notice === undefined ? {} : { notice })
  };
}

export function createIngredientPhotoPageRuntime(
  runtime: LocalImageCandidateRuntime,
  refreshPlanning: PlanningRefresh
): IngredientPhotoPageRuntime {
  let previewUrl: string | undefined;

  function releasePreview(): void {
    if (previewUrl !== undefined) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }

  return {
    async selectImage(file) {
      releasePreview();
      previewUrl = URL.createObjectURL(file);
      try {
        return imageSnapshot(await runtime.selectFile(file), previewUrl);
      } catch (error: unknown) {
        releasePreview();
        throw error;
      }
    },
    async recognize() {
      try {
        return imageSnapshot(await runtime.recognize(), previewUrl);
      } catch {
        releasePreview();
        return {
          status: 'manual_fallback',
          candidates: [],
          notice: '图片识别当前不可用，请改用手动库存录入。'
        };
      }
    },
    async confirm(candidateId, grams) {
      await runtime.confirm(candidateId, grams);
      releasePreview();
      await refreshPlanning();
      return {
        status: 'confirmed',
        candidates: [],
        notice: '已确认写入测试库存。'
      };
    },
    cancel() {
      const snapshot = runtime.cancel();
      releasePreview();
      return Promise.resolve(imageSnapshot(snapshot, undefined));
    }
  };
}
