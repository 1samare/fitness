export interface ControlledBetaMetadata {
  readonly operatorName: string;
  readonly privacyContact: string;
  readonly privacyNoticeVersion: string;
}

export function validateControlledBetaMetadata(
  environment: Readonly<Record<string, string | undefined>>
): ControlledBetaMetadata;

export function parseConfiguredServerNames(value: string | undefined): ReadonlySet<string>;
