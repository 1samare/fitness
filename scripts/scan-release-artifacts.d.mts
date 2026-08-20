export interface ReleaseArtifactFinding {
  readonly path: string;
  readonly ruleId: string;
}

export interface ReleaseArtifactScanReport {
  readonly status: 'passed' | 'failed';
  readonly findings: readonly ReleaseArtifactFinding[];
}

export function scanReleaseArtifacts(input: {
  readonly repositoryRoot: string;
}): Promise<ReleaseArtifactScanReport>;
