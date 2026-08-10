export class DuplicateReviewedRecordError extends Error {
  public readonly code = 'duplicate_reviewed_record' as const;

  public constructor(public readonly recordId: string) {
    super(`Reviewed record ID is duplicated: ${recordId}`);
    this.name = 'DuplicateReviewedRecordError';
  }
}

export function assertUniqueRecordIds(
  records: readonly { readonly id: string }[]
): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new DuplicateReviewedRecordError(record.id);
    ids.add(record.id);
  }
}
