export interface ReleaseCommand {
  readonly name: string;
}

export interface ReleaseCommandResult {
  readonly name: string;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: 'passed' | 'failed';
}

export interface ReleaseCommandSequenceResult {
  readonly status: 'passed' | 'failed';
  readonly failedCommand: string | null;
  readonly results: readonly ReleaseCommandResult[];
}

export function runCommandSequence(input: {
  readonly commands: readonly ReleaseCommand[];
  readonly spawnCommand: (command: ReleaseCommand) => Promise<{ readonly exitCode: number }>;
}): Promise<ReleaseCommandSequenceResult>;
