export class LocalUserMismatchError extends Error {
  public readonly code = 'local_user_mismatch' as const;

  public constructor(userId: string) {
    super(`Local repository only accepts local-default, received ${userId}`);
    this.name = 'LocalUserMismatchError';
  }
}

export class LocalRevisionConflictError extends Error {
  public readonly code = 'local_revision_conflict' as const;

  public constructor(
    public readonly expectedRevision: number,
    public readonly actualRevision: number
  ) {
    super(`Local revision conflict: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`);
    this.name = 'LocalRevisionConflictError';
  }
}

export class LocalDatabaseUpgradeBlockedError extends Error {
  public readonly code = 'local_database_upgrade_blocked' as const;

  public constructor(databaseName: string) {
    super(`Close other tabs before upgrading local database ${databaseName}`);
    this.name = 'LocalDatabaseUpgradeBlockedError';
  }
}

export class LocalBackupValidationError extends Error {
  public readonly code = 'local_backup_invalid' as const;

  public constructor(message = 'Local backup is invalid') {
    super(message);
    this.name = 'LocalBackupValidationError';
  }
}

export class LocalBackupChecksumError extends Error {
  public readonly code = 'local_backup_checksum_mismatch' as const;

  public constructor() {
    super('Local backup checksum does not match its payload');
    this.name = 'LocalBackupChecksumError';
  }
}

export class LocalBackupOverwriteRequiredError extends Error {
  public readonly code = 'local_backup_overwrite_required' as const;

  public constructor() {
    super('Explicit overwrite confirmation is required for non-empty local data');
    this.name = 'LocalBackupOverwriteRequiredError';
  }
}

export class LocalBackupDatasetMismatchError extends Error {
  public readonly code = 'local_backup_dataset_mismatch' as const;

  public constructor() {
    super('Local backup dataset does not match the expected test dataset');
    this.name = 'LocalBackupDatasetMismatchError';
  }
}
