export interface ReleasePreflightCheck {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly detail: string;
}

export interface ReleasePreflightReport {
  readonly schemaVersion: 'phase-7-release-preflight-report-v1';
  readonly status: 'passed' | 'failed';
  readonly checks: readonly ReleasePreflightCheck[];
}

export function runReleasePreflight(input: {
  readonly repositoryRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runCliVersion: () => Promise<string>;
  readonly isTracked: (relativePath: string) => boolean | Promise<boolean>;
}): Promise<ReleasePreflightReport>;

export function formatReleasePreflightReport(report: ReleasePreflightReport): string;
