import { describe, expect, test } from 'vitest';
import type { PublicIngredientPhoto } from '@fitness/contracts';
import { createIngredientPhotoViewModel, selectIngredientCandidate } from './view-model';

const recognizedPhoto: PublicIngredientPhoto = {
  photoId: 'photo-a',
  revision: 3,
  workflowStatus: 'recognized',
  storageStatus: 'retained',
  deleteDueAt: '2026-08-20T10:00:00.000Z',
  candidates: [
    {
      id: 'candidate-high', foodId: 'food-chicken', canonicalNameZh: '审核鸡胸肉',
      confidence: 0.98, foodState: 'cooked'
    },
    {
      id: 'candidate-low', foodId: 'food-rice', canonicalNameZh: '审核米饭',
      confidence: 0.64, foodState: 'raw'
    }
  ],
  confirmedCandidateId: null,
  inventoryVersionId: null
};

describe('ingredient photo view model', () => {
  test('does not preselect the highest-confidence candidate', () => {
    const viewModel = createIngredientPhotoViewModel(recognizedPhoto);

    expect(viewModel.selectedCandidateId).toBeNull();
    expect(viewModel.showGramsInput).toBe(false);
  });

  test('labels canonical names, food states, confidence, and confirmation status', () => {
    expect(createIngredientPhotoViewModel(recognizedPhoto).candidates).toEqual([
      {
        id: 'candidate-high', canonicalNameZh: '审核鸡胸肉',
        foodStateText: '熟制', confidenceText: '约 98%',
        confirmationLabel: '估算识别结果，请确认'
      },
      {
        id: 'candidate-low', canonicalNameZh: '审核米饭',
        foodStateText: '生鲜', confidenceText: '约 64%',
        confirmationLabel: '估算识别结果，请确认'
      }
    ]);
  });

  test('shows the user-estimated grams field only after explicit candidate selection', () => {
    const initial = createIngredientPhotoViewModel(recognizedPhoto);
    const selected = selectIngredientCandidate(initial, 'candidate-low');

    expect(selected.selectedCandidateId).toBe('candidate-low');
    expect(selected.showGramsInput).toBe(true);
    expect(() => selectIngredientCandidate(initial, 'candidate-from-client'))
      .toThrow('候选已失效，请重新识别');
  });
});
