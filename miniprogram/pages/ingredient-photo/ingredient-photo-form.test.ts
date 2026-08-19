import { describe, expect, test } from 'vitest';
import {
  buildConfirmIngredientCommand,
  buildCreateIngredientPhotoUploadCommand,
  buildRecognizeIngredientPhotoCommand,
  buildRegisterIngredientPhotoUploadCommand
} from './ingredient-photo-form';

describe('ingredient photo command builders', () => {
  test('builds all four strict API actions from explicit inputs', () => {
    expect(buildCreateIngredientPhotoUploadCommand({
      mediaType: 'image/jpeg', expectedVersion: 0, idempotencyKey: 'photo-create-001'
    })).toEqual({
      action: 'createIngredientPhotoUpload',
      payload: {
        expectedVersion: 0,
        idempotencyKey: 'photo-create-001',
        payload: { mediaType: 'image/jpeg' }
      }
    });
    expect(buildRegisterIngredientPhotoUploadCommand({
      photoId: 'photo-a', privateFileId: 'cloud://private/photo-a.jpg',
      photoRevision: 1, idempotencyKey: 'photo-register-001'
    })).toEqual({
      action: 'registerIngredientPhotoUpload',
      payload: {
        expectedVersion: 1,
        idempotencyKey: 'photo-register-001',
        payload: { photoId: 'photo-a', privateFileId: 'cloud://private/photo-a.jpg' }
      }
    });
    expect(buildRecognizeIngredientPhotoCommand({
      photoId: 'photo-a', photoRevision: 2, idempotencyKey: 'photo-recognize-001'
    })).toEqual({
      action: 'recognizeIngredientPhoto',
      payload: {
        expectedVersion: 2,
        idempotencyKey: 'photo-recognize-001',
        payload: { photoId: 'photo-a' }
      }
    });
  });

  test('requires an explicit candidate and a positive integer gram value', () => {
    expect(buildConfirmIngredientCommand({
      photoId: 'photo-a', photoRevision: 3, selectedCandidateId: null,
      gramsText: '125', expectedInventoryVersion: 0,
      idempotencyKey: 'photo-confirm-001'
    })).toEqual({ ok: false, reason: 'candidate_required' });
    expect(buildConfirmIngredientCommand({
      photoId: 'photo-a', photoRevision: 3, selectedCandidateId: 'candidate-a',
      gramsText: '125.5', expectedInventoryVersion: 0,
      idempotencyKey: 'photo-confirm-001'
    })).toEqual({ ok: false, reason: 'grams_must_be_positive_integer' });
  });

  test.each(['0', '-1', '0001', '1000001', '9007199254740992'])(
    'rejects out-of-contract gram input %s',
    (gramsText) => {
      expect(buildConfirmIngredientCommand({
        photoId: 'photo-a', photoRevision: 3, selectedCandidateId: 'candidate-a',
        gramsText, expectedInventoryVersion: 0, idempotencyKey: 'photo-confirm-001'
      })).toEqual({ ok: false, reason: 'grams_must_be_positive_integer' });
    }
  );

  test('builds confirmation only after an explicit candidate and valid grams', () => {
    expect(buildConfirmIngredientCommand({
      photoId: 'photo-a', photoRevision: 3, selectedCandidateId: 'candidate-a',
      gramsText: '125', expectedInventoryVersion: 4,
      idempotencyKey: 'photo-confirm-001'
    })).toEqual({
      ok: true,
      request: {
        action: 'confirmIngredientCandidate',
        payload: {
          expectedVersion: 3,
          idempotencyKey: 'photo-confirm-001',
          payload: {
            photoId: 'photo-a', candidateId: 'candidate-a',
            confirmedGrams: 125, expectedInventoryVersion: 4
          }
        }
      }
    });
  });
});
