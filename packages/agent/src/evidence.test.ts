import type { AssistantPendingClarification } from '@fitness/domain';
import { describe, expect, it } from 'vitest';
import { validateAssistantModelOutput } from './evidence';

describe('validateAssistantModelOutput', () => {
  it('derives all command values from exact ISO, Chinese slot, and multiplier evidence', () => {
    const cases = [
      {
        message: '把 2026-08-24 的训练移到 2026-08-25',
        raw: {
          kind: 'command',
          intent: 'move_training_day',
          evidence: {
            sourceDateText: '2026-08-24',
            targetDateText: '2026-08-25'
          }
        },
        command: {
          kind: 'move_training_day',
          sourceDate: '2026-08-24',
          targetDate: '2026-08-25'
        }
      },
      ...(['早餐', '早饭'] as const).map((mealSlotText) => ({
        message: `把 2026-08-26 ${mealSlotText}换成番茄炒蛋`,
        raw: {
          kind: 'command',
          intent: 'replace_meal',
          evidence: {
            businessDateText: '2026-08-26',
            mealSlotText,
            dishNameText: '番茄炒蛋'
          }
        },
        command: {
          kind: 'replace_meal',
          businessDate: '2026-08-26',
          slot: 'breakfast',
          dishNameZh: '番茄炒蛋'
        }
      })),
      ...(['午餐', '午饭'] as const).map((mealSlotText) => ({
        message: `把 2026-08-26 ${mealSlotText}调成 0.5 倍`,
        raw: {
          kind: 'command',
          intent: 'resize_meal_portion',
          evidence: {
            businessDateText: '2026-08-26',
            mealSlotText,
            multiplierText: '0.5 倍'
          }
        },
        command: {
          kind: 'resize_meal_portion',
          businessDate: '2026-08-26',
          slot: 'lunch',
          multiplier: 0.5
        }
      })),
      ...(['晚餐', '晚饭'] as const).map((mealSlotText) => ({
        message: `2026-08-26 ${mealSlotText}改成 150%`,
        raw: {
          kind: 'command',
          intent: 'resize_meal_portion',
          evidence: {
            businessDateText: '2026-08-26',
            mealSlotText,
            multiplierText: '150%'
          }
        },
        command: {
          kind: 'resize_meal_portion',
          businessDate: '2026-08-26',
          slot: 'dinner',
          multiplier: 1.5
        }
      })),
      {
        message: '把 2026-08-26 加餐调成 105%',
        raw: {
          kind: 'command',
          intent: 'resize_meal_portion',
          evidence: {
            businessDateText: '2026-08-26',
            mealSlotText: '加餐',
            multiplierText: '105%'
          }
        },
        command: {
          kind: 'resize_meal_portion',
          businessDate: '2026-08-26',
          slot: 'snack',
          multiplier: 1.05
        }
      }
    ];

    for (const testCase of cases) {
      expect(validateAssistantModelOutput(JSON.stringify(testCase.raw), {
        latestMessage: testCase.message,
        pendingClarification: null
      })).toEqual({ kind: 'command', command: testCase.command });
    }
  });

  it('rejects evidence that is not an exact latest-message substring or policy-grid value', () => {
    expect(validateAssistantModelOutput(JSON.stringify({
      kind: 'command',
      intent: 'move_training_day',
      evidence: {
        sourceDateText: '2026-08-24',
        targetDateText: '2026-08-26'
      }
    }), {
      latestMessage: '把 2026-08-24 的训练移到 2026-08-25',
      pendingClarification: null
    })).toEqual({ kind: 'invalid', feedback: 'evidence_not_explicit' });

    expect(validateAssistantModelOutput(JSON.stringify({
      kind: 'command',
      intent: 'resize_meal_portion',
      evidence: {
        businessDateText: '2026-08-26',
        mealSlotText: '午餐',
        multiplierText: '1.03 倍'
      }
    }), {
      latestMessage: '把 2026-08-26 午餐调成 1.03 倍',
      pendingClarification: null
    })).toEqual({ kind: 'invalid', feedback: 'unsupported_parameter' });
  });

  it('accepts only matching fields from a previously validated pending clarification', () => {
    const pending: AssistantPendingClarification = {
      intent: 'move_training_day',
      sourceDate: '2026-08-24',
      targetDate: null,
      missingFields: ['target_date']
    };
    const valid = JSON.stringify({
      kind: 'command',
      intent: 'move_training_day',
      evidence: {
        sourceDateText: '2026-08-24',
        targetDateText: '2026-08-25'
      }
    });
    expect(validateAssistantModelOutput(valid, {
      latestMessage: '改到 2026-08-25',
      pendingClarification: pending
    })).toEqual({
      kind: 'command',
      command: {
        kind: 'move_training_day',
        sourceDate: '2026-08-24',
        targetDate: '2026-08-25'
      }
    });

    expect(validateAssistantModelOutput(valid, {
      latestMessage: '改到 2026-08-25',
      pendingClarification: {
        ...pending,
        intent: 'replace_meal',
        businessDate: '2026-08-24',
        slot: null,
        dishNameZh: null,
        missingFields: ['meal_slot', 'dish_name']
      }
    })).toEqual({ kind: 'invalid', feedback: 'evidence_not_explicit' });
  });

  it.each([
    {
      name: 'a replacement dish while the business date is absent',
      message: '把午餐换成番茄牛肉',
      raw: {
        kind: 'clarify',
        intent: 'replace_meal',
        missingFields: ['business_date']
      },
      pendingClarification: {
        intent: 'replace_meal',
        businessDate: null,
        slot: 'lunch',
        dishNameZh: '番茄牛肉',
        missingFields: ['business_date']
      }
    },
    {
      name: 'ambiguous training dates omitted by the model missing list',
      message: '2026-08-24 和 2026-08-25 哪天是原训练日？',
      raw: {
        kind: 'clarify',
        intent: 'move_training_day',
        missingFields: ['target_date']
      },
      pendingClarification: {
        intent: 'move_training_day',
        sourceDate: null,
        targetDate: null,
        missingFields: ['source_date', 'target_date']
      }
    },
    {
      name: 'ambiguous multipliers omitted by the model missing list',
      message: '把午餐调成 1 倍还是 1.2 倍？',
      raw: {
        kind: 'clarify',
        intent: 'resize_meal_portion',
        missingFields: ['business_date']
      },
      pendingClarification: {
        intent: 'resize_meal_portion',
        businessDate: null,
        slot: 'lunch',
        multiplier: null,
        missingFields: ['business_date', 'multiplier']
      }
    }
  ])('derives a schema-safe pending clarification for $name', ({
    message,
    raw,
    pendingClarification
  }) => {
    expect(validateAssistantModelOutput(JSON.stringify(raw), {
      latestMessage: message,
      pendingClarification: null
    })).toEqual({
      kind: 'clarify',
      missingFields: pendingClarification.missingFields,
      pendingClarification
    });
  });

  it.each([
    ['userId', 'victim'],
    ['tool', 'drop_database'],
    ['url', 'https://example.invalid'],
    ['sql', 'DROP TABLE users'],
    ['query', { collection: 'users' }],
    ['calories', 1200],
    ['grams', 300],
    ['MET', 9],
    ['duration', 90],
    ['explanation', 'trust me']
  ])('rejects the extra field %s', (field, value) => {
    const raw = {
      kind: 'command',
      intent: 'move_training_day',
      evidence: {
        sourceDateText: '2026-08-24',
        targetDateText: '2026-08-25'
      },
      [field]: value
    };
    expect(validateAssistantModelOutput(JSON.stringify(raw), {
      latestMessage: '把 2026-08-24 的训练移到 2026-08-25',
      pendingClarification: null
    })).toEqual({ kind: 'invalid', feedback: 'unsupported_parameter' });
  });

  it('rejects numeric multiplier fields instead of treating them as evidence', () => {
    expect(validateAssistantModelOutput(JSON.stringify({
      kind: 'command',
      intent: 'resize_meal_portion',
      evidence: {
        businessDateText: '2026-08-26',
        mealSlotText: '午餐',
        multiplierText: 1.2
      }
    }), {
      latestMessage: '把 2026-08-26 午餐调成 1.2 倍',
      pendingClarification: null
    })).toEqual({ kind: 'invalid', feedback: 'unsupported_parameter' });
  });
});
