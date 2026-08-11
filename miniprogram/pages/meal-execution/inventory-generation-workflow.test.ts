import { describe, expect, test } from 'vitest';
import { buildGenerateMealPlanRequest, buildInventoryRequest } from './form';
import {
  advanceInventoryGenerationWorkflow,
  createInventoryGenerationWorkflow,
  inventoryGenerationWorkflowMatches,
  markInventoryGenerationWorkflowRecovery,
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
    expect(initial.recoveryStatus).toBe('replay_required');
    expect(parseInventoryGenerationWorkflow(JSON.parse(JSON.stringify(initial)))).toEqual(initial);
    expect(inventoryGenerationWorkflowMatches(initial, requests())).toBe(true);

    const advanced = advanceInventoryGenerationWorkflow(initial, 'inventory-version-1');
    expect(advanced).toMatchObject({
      stage: 'generation_pending', recoveryStatus: 'replay_required',
      inventoryVersionId: 'inventory-version-1',
      inventoryRequest: initial.inventoryRequest,
      generationRequest: initial.generationRequest
    });
    expect(parseInventoryGenerationWorkflow(JSON.parse(JSON.stringify(advanced)))).toEqual(advanced);
  });

  test.each([
    [
      'confirmed_infeasible',
      '当前食材与营养目标没有可行餐单。服务已确认本次没有写入餐单；请调整食材后明确重新生成。'
    ],
    [
      'inventory_mismatch',
      '已生成餐单未关联本次保存或当前生效的库存。旧餐单会保留并标记待更新；请明确按当前库存重新生成。'
    ]
  ] as const)('persists the safe terminal %s state across reloads', (status, safeMessage) => {
    const advanced = advanceInventoryGenerationWorkflow(
      createInventoryGenerationWorkflow(requests()),
      'inventory-version-1'
    );
    const terminal = markInventoryGenerationWorkflowRecovery(advanced, status);

    expect(terminal).toMatchObject({
      stage: 'generation_pending', recoveryStatus: status, recoveryMessage: safeMessage
    });
    expect(JSON.stringify(terminal)).not.toContain('provider response body');
    expect(parseInventoryGenerationWorkflow(JSON.parse(JSON.stringify(terminal)))).toEqual(terminal);
  });

  test('migrates a legacy replay record and rejects impossible terminal states', () => {
    const current = createInventoryGenerationWorkflow(requests());
    const legacy = {
      fingerprint: current.fingerprint,
      stage: current.stage,
      inventoryRequest: current.inventoryRequest,
      generationRequest: current.generationRequest,
      inventoryVersionId: current.inventoryVersionId
    };
    expect(parseInventoryGenerationWorkflow(legacy)).toEqual(current);
    expect(() => markInventoryGenerationWorkflowRecovery(
      current,
      'confirmed_infeasible'
    )).toThrow('餐单生成阶段');
    expect(parseInventoryGenerationWorkflow({
      ...current,
      recoveryStatus: 'inventory_mismatch',
      recoveryMessage: '错误状态'
    })).toBeUndefined();
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
    expect(parseInventoryGenerationWorkflow({
      ...advanceInventoryGenerationWorkflow(initial, 'inventory-version-1'),
      recoveryStatus: 'unknown_status',
      recoveryMessage: 'unsafe'
    })).toBeUndefined();
    const terminal = markInventoryGenerationWorkflowRecovery(
      advanceInventoryGenerationWorkflow(initial, 'inventory-version-1'),
      'confirmed_infeasible'
    );
    expect(parseInventoryGenerationWorkflow({
      ...terminal,
      recoveryMessage: 'provider response body'
    })).toBeUndefined();
  });
});
