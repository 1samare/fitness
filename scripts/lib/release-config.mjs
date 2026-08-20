const DEVELOPMENT_VALUES = new Set([
  '仅限本地开发，不得发布',
  'local-only@invalid.example',
  'local-dev'
]);

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name}: missing`);
  }
  return value;
}

export function validateControlledBetaMetadata(environment) {
  const operatorName = requiredValue(environment, 'FITNESS_PUBLIC_OPERATOR_NAME');
  const privacyContact = requiredValue(environment, 'FITNESS_PUBLIC_PRIVACY_CONTACT');
  const privacyNoticeVersion = requiredValue(environment, 'FITNESS_PRIVACY_NOTICE_VERSION');
  if ([operatorName, privacyContact, privacyNoticeVersion].some((value) => (
    DEVELOPMENT_VALUES.has(value)
  ))) {
    throw new Error('Controlled-beta metadata contains development-only values');
  }
  if (operatorName.length > 120) throw new Error('Operator name format is invalid');
  if (!(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(privacyContact)
    || /^https:\/\/[^\s]+$/.test(privacyContact)
  )) {
    throw new Error('Privacy contact format is invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(privacyNoticeVersion)) {
    throw new Error('Privacy notice version format is invalid');
  }
  return { operatorName, privacyContact, privacyNoticeVersion };
}

export function parseConfiguredServerNames(value) {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new Error('FITNESS_CLOUDBASE_CONFIGURED_NAMES: missing');
  }
  const names = raw.split(',').map((name) => name.trim());
  if (names.some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name))) {
    throw new Error('Configured server setting name is invalid');
  }
  return new Set([...new Set(names)].sort());
}
