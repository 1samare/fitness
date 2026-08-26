import { describe, expect, it } from 'vitest';
import { createContentSecurityPolicy } from './content-security-policy';

describe('createContentSecurityPolicy', () => {
  it("uses only 'none' when no connection source is allowed", () => {
    expect(createContentSecurityPolicy([])).toContain("connect-src 'none';");
  });

  it("does not combine 'none' with allowed connection sources", () => {
    const policy = createContentSecurityPolicy(["'self'", 'https://example.invalid']);

    expect(policy).toContain("connect-src 'self' https://example.invalid;");
    expect(policy).not.toContain("connect-src 'self' https://example.invalid 'none';");
  });

  it('allows in-memory blob image previews without allowing blob scripts', () => {
    const policy = createContentSecurityPolicy(["'self'"]);

    expect(policy).toContain("img-src 'self' data: blob:;");
    expect(policy).toContain("script-src 'self';");
  });
});
