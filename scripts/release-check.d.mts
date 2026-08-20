export interface ReleaseCheckCommand {
  readonly name: string;
  readonly executable?: string;
  readonly args?: readonly string[];
}

export interface ReleaseCheckCommandExecution {
  readonly exitCode: number;
  readonly output: string;
}

export interface ReleaseCheckResult {
  readonly status: 'passed' | 'failed';
  readonly failedCommand: string | null;
  readonly results: readonly {
    readonly name: string;
    readonly exitCode: number;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly status: 'passed' | 'failed';
  }[];
}

export const RELEASE_CHECK_COMMAND_NAMES: readonly string[];

export function runReleaseCheck(input: {
  readonly runCommand: (
    command: ReleaseCheckCommand
  ) => Promise<ReleaseCheckCommandExecution>;
  readonly writeEvidence: (report: ReleaseCheckResult) => Promise<void>;
}): Promise<ReleaseCheckResult>;
