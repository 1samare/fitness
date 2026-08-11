import { describe, expect, test } from 'vitest';
import { buildGenerateMealPlanRequest, buildInventoryRequest } from './form';
import {
  advanceInventoryGenerationWorkflow,
  createInventoryGenerationWorkflow,
  inventoryGenerationWorkflowMatches,
  parseInventoryGenerationWorkflow
} from './inventory-generation-workflow';

function requests() {
  return {
    inventoryRequest: buildInventoryRequest({
      rows: [{ name: '测试米饭', availableGrams: '500' }],
      expectedVersion: 2,
      idempotencyKey: 'inventory-key-001'
    }),
    generationRequest: buildGenerateMealPlanRequest({
      weekStartDate: '2026-08-17', businessToday: '2026-08-10',
      expectedVersion: 3, idempotencyKey: 'generate-key-001'
    })
  };
}

describe('inventory generation workflow', () => {
  test('persists exact schema-valid envelopes and advances without rebuilding generation', () => {
    const initial = createInventoryGenerationWorkflow(requests());
    expect(initial.stage).toBe('inventory_pending');
    expect(parseInventoryGenerationWorkflow(JSON.parse(JSON.stringify(initial)))).toEqual(initial);
    expect(inventoryGenerationWorkflowMatches(initial, requests())).toBe(true);

    const advanced = advanceInventoryGenerationWorkflow(initial, 'inventory-version-1');
    expect(advanced).toMatchObject({
      stage: 'generation_pending', inventoryVersionId: 'inventory-version-1',
      inventoryRequest: initial.inventoryRequest,
      generationRequest: initial.generationRequest
    });
    expect(parseInventoryGenerationWorkflow(JSON.parse(JSON.stringify(advanced)))).toEqual(advanced);
  });

  test('does not treat changed visible input or week as the same unresolved workflow', () => {
    const workflow = createInventoryGenerationWorkflow(requests());
    const changedItems = requests();
    changedItems.inventoryRequest = buildInventoryRequest({
      rows: [{ name: '测试米饭', availableGrams: '501' }],
      expectedVersion: 2, idempotencyKey: 'inventory-key-002'
    });
    expect(inventoryGenerationWorkflowMatches(workflow, changedItems)).toBe(false);
    const changedWeek = requests();
    changedWeek.generationRequest = buildGenerateMealPlanRequest({
      weekStartDate: '2026-08-24', businessToday: '2026-08-10',
      expectedVersion: 3, idempotencyKey: 'generate-key-002'
    });
    expect(inventoryGenerationWorkflowMatches(workflow, changedWeek)).toBe(false);
  });

  test('rejects damaged storage instead of inventing partial requests', () => {
    const initial = createInventoryGenerationWorkflow(requests());
    expect(parseInventoryGenerationWorkflow({ ...initial, inventoryVersionId: 'forged' })).toBeUndefined();
    expect(parseInventoryGenerationWorkflow({
      ...advanceInventoryGenerationWorkflow(initial, 'inventory-version-1'),
      generationRequest: { ...initial.generationRequest, action: 'saveInventory' }
    })).toBeUndefined();
    expect(parseInventoryGenerationWorkflow({ ...initial, fingerprint: 'tampered' })).toBeUndefined();
  });
});
