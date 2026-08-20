export interface ReleaseMetadata {
  readonly channel: 'development' | 'controlled_beta';
  readonly operatorName: string;
  readonly privacyContact: string;
  readonly privacyNoticeVersion: string;
}

const configuredChannel = typeof __FITNESS_RELEASE_CHANNEL__ === 'undefined'
  ? 'development'
  : __FITNESS_RELEASE_CHANNEL__;

export const releaseMetadata: ReleaseMetadata = Object.freeze({
  channel: configuredChannel,
  operatorName: typeof __FITNESS_PUBLIC_OPERATOR_NAME__ === 'undefined'
    ? '仅限本地开发，不得发布'
    : __FITNESS_PUBLIC_OPERATOR_NAME__,
  privacyContact: typeof __FITNESS_PUBLIC_PRIVACY_CONTACT__ === 'undefined'
    ? 'local-only@invalid.example'
    : __FITNESS_PUBLIC_PRIVACY_CONTACT__,
  privacyNoticeVersion: typeof __FITNESS_PRIVACY_NOTICE_VERSION__ === 'undefined'
    ? 'local-dev'
    : __FITNESS_PRIVACY_NOTICE_VERSION__
});
