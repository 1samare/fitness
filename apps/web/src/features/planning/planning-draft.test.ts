import { describe, expect, test } from 'vitest';
import { createDefaultPlanningSetupForm } from './planning-form';
import {
  clearPlanningSetupDraft,
  loadPlanningSetupDraft,
  savePlanningSetupDraft
} from './planning-draft';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => { values.clear(); },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

describe('planning setup draft', () => {
  test('round-trips a browser session draft and clears it after success', () => {
    const storage = memoryStorage();
    const form = { ...createDefaultPlanningSetupForm('2026-08-26'), weightKg: '63.5' };

    savePlanningSetupDraft(storage, form);
    expect(loadPlanningSetupDraft(storage)).toEqual(form);

    clearPlanningSetupDraft(storage);
    expect(loadPlanningSetupDraft(storage)).toBeNull();
  });

  test('rejects and removes a damaged or structurally incomplete draft', () => {
    const storage = memoryStorage();
    storage.setItem('fitness_local_v1_setup_draft', '{"ageYears":30}');

    expect(loadPlanningSetupDraft(storage)).toBeNull();
    expect(storage.length).toBe(0);
  });
});
