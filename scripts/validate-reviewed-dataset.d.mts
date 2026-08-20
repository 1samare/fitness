import type { ReviewedPlanningDatasetV1 } from '@fitness/contracts';

export interface ReviewedDatasetEvidence {
  readonly schemaVersion: 'phase-7-dataset-validation-evidence-v1';
  readonly datasetIdHashSha256: string;
  readonly datasetVersion: string;
  readonly checksumSha256: string;
  readonly recordCounts: {
    readonly nutritionSnapshots: number;
    readonly recipeTemplates: number;
    readonly dailyMenus: number;
  };
  readonly validatedAt: string;
  readonly status: 'passed';
}

export function validateDatasetFile(input: {
  readonly inputPath: string;
  readonly evidenceDirectory: string;
  readonly now: string;
  readonly validate?: (
    value: unknown,
    now: string
  ) => ReviewedPlanningDatasetV1;
}): Promise<ReviewedDatasetEvidence>;
