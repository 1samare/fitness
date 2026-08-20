import type { MealSlot } from './meal-planning';

export type AssistantIntent =
  | 'move_training_day'
  | 'replace_meal'
  | 'resize_meal_portion';

export type AssistantValidatedCommand =
  | {
      readonly kind: 'move_training_day';
      readonly sourceDate: string;
      readonly targetDate: string;
    }
  | {
      readonly kind: 'replace_meal';
      readonly businessDate: string;
      readonly slot: MealSlot;
      readonly dishNameZh: string;
    }
  | {
      readonly kind: 'resize_meal_portion';
      readonly businessDate: string;
      readonly slot: MealSlot;
      readonly multiplier: number;
    };

export type AssistantMissingField =
  | 'source_date'
  | 'target_date'
  | 'business_date'
  | 'meal_slot'
  | 'dish_name'
  | 'multiplier';

export type AssistantPendingClarification =
  | {
      readonly intent: 'move_training_day';
      readonly sourceDate: string | null;
      readonly targetDate: string | null;
      readonly missingFields: readonly ('source_date' | 'target_date')[];
    }
  | {
      readonly intent: 'replace_meal';
      readonly businessDate: string | null;
      readonly slot: MealSlot | null;
      readonly dishNameZh: string | null;
      readonly missingFields: readonly ('business_date' | 'meal_slot' | 'dish_name')[];
    }
  | {
      readonly intent: 'resize_meal_portion';
      readonly businessDate: string | null;
      readonly slot: MealSlot | null;
      readonly multiplier: number | null;
      readonly missingFields: readonly ('business_date' | 'meal_slot' | 'multiplier')[];
    };

export type AssistantRecoveryAction =
  | 'none'
  | 'retry'
  | 'open_training_plan'
  | 'open_meal_plan'
  | 'review_meal_plan_changes';

export type AssistantTurnResult =
  | {
      readonly kind: 'command_executed';
      readonly command: AssistantIntent;
      readonly message: string;
      readonly recoveryAction: AssistantRecoveryAction;
    }
  | {
      readonly kind: 'clarification_required';
      readonly missingFields: readonly AssistantMissingField[];
      readonly pendingClarification: AssistantPendingClarification;
      readonly message: string;
    }
  | {
      readonly kind: 'request_rejected';
      readonly reason: 'unsupported_request' | 'unsafe_or_prohibited';
      readonly message: string;
    }
  | {
      readonly kind: 'assistant_unavailable';
      readonly reason: 'model_output_invalid' | 'provider_unavailable' | 'internal_error';
      readonly message: string;
      readonly recoveryAction: AssistantRecoveryAction;
    }
  | {
      readonly kind: 'command_rejected';
      readonly reason:
        | 'request_not_allowed'
        | 'command_rejected'
        | 'nutrition_constraints_infeasible';
      readonly message: string;
      readonly recoveryAction: AssistantRecoveryAction;
    };

export interface AssistantConversationMessage {
  readonly turnId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
}

interface AssistantPendingTurnBase {
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly expectedVersion: number;
  readonly message: string;
  readonly startedAt: string;
}

export interface AssistantReceivedTurn extends AssistantPendingTurnBase {
  readonly status: 'received';
}

export interface AssistantValidatedTurn extends AssistantPendingTurnBase {
  readonly status: 'validated';
  readonly command: AssistantValidatedCommand;
}

export type AssistantPendingTurn = AssistantReceivedTurn | AssistantValidatedTurn;

export interface AssistantTurnReceipt {
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly conversationVersion: number;
  readonly completedAt: string;
  readonly result: AssistantTurnResult;
}

export interface AssistantConversationSummary {
  readonly activeWeekStartDate: string | null;
  readonly trainingPlanVersion: number;
  readonly mealPlanVersion: number;
  readonly lockedMealDates: readonly string[];
  readonly pendingClarification: AssistantPendingClarification | null;
}

export interface AssistantConversationState {
  readonly version: number;
  readonly recentMessages: readonly AssistantConversationMessage[];
  readonly summary: AssistantConversationSummary;
  readonly pendingTurn: AssistantPendingTurn | null;
  readonly recentReceipts: readonly AssistantTurnReceipt[];
}

export function emptyAssistantConversationState(): AssistantConversationState {
  return {
    version: 0,
    recentMessages: [],
    summary: {
      activeWeekStartDate: null,
      trainingPlanVersion: 0,
      mealPlanVersion: 0,
      lockedMealDates: [],
      pendingClarification: null
    },
    pendingTurn: null,
    recentReceipts: []
  };
}
