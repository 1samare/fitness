export function createContentSecurityPolicy(connectSources: readonly string[]): string {
  const normalizedSources = connectSources.length === 0 ? "'none'" : connectSources.join(' ');
  return `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src ${normalizedSources}; script-src 'self'; frame-ancestors 'none';`;
}
