import type { PlanningAggregateState } from '@fitness/domain';
import type { PlanningRepository } from './versioned-planning';

export interface PersonalDataRepository extends PlanningRepository {
  readExisting(userId: string): Promise<PlanningAggregateState | null>;
  deleteExisting<TResult>(
    userId: string,
    operation: (current: PlanningAggregateState) => TResult
  ): Promise<TResult>;
}

export class PersonalDataDocumentNotFoundError extends Error {
  public readonly code = 'personal_data_document_not_found' as const;

  public constructor() {
    super('Personal data document does not exist');
    this.name = 'PersonalDataDocumentNotFoundError';
  }
}
