import type { PublicIngredientPhoto } from '@fitness/contracts';

export interface IngredientCandidateDisplay {
  readonly id: string;
  readonly canonicalNameZh: string;
  readonly foodStateText: string;
  readonly confidenceText: string;
  readonly confirmationLabel: '估算识别结果，请确认';
}

export interface IngredientPhotoViewModel {
  readonly photoId: string;
  readonly photoRevision: number;
  readonly candidates: readonly IngredientCandidateDisplay[];
  readonly selectedCandidateId: string | null;
  readonly showGramsInput: boolean;
}

function foodStateText(foodState: 'raw' | 'cooked' | 'dry'): string {
  if (foodState === 'raw') return '生鲜';
  if (foodState === 'cooked') return '熟制';
  return '干制';
}

export function createIngredientPhotoViewModel(
  photo: PublicIngredientPhoto
): IngredientPhotoViewModel {
  return {
    photoId: photo.photoId,
    photoRevision: photo.revision,
    candidates: photo.candidates.map((candidate) => ({
      id: candidate.id,
      canonicalNameZh: candidate.canonicalNameZh,
      foodStateText: foodStateText(candidate.foodState),
      confidenceText: `约 ${String(Math.round(candidate.confidence * 100))}%`,
      confirmationLabel: '估算识别结果，请确认'
    })),
    selectedCandidateId: null,
    showGramsInput: false
  };
}

export function selectIngredientCandidate(
  viewModel: IngredientPhotoViewModel,
  candidateId: string
): IngredientPhotoViewModel {
  if (!viewModel.candidates.some((candidate) => candidate.id === candidateId)) {
    throw new Error('候选已失效，请重新识别');
  }
  return { ...viewModel, selectedCandidateId: candidateId, showGramsInput: true };
}
