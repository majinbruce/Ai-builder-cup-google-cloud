import { describe, expect, it } from "vitest";
import { checkImageUrl, checkPasswordPolicy } from "../src/modules/auth/auth.policies.ts";

/**
 * Pure functions, so these need no app and no database — they live in the
 * `unit` project. The integration counterparts (test/integration/hardening.
 * test.ts) assert that Better Auth actually calls them; these assert that they
 * decide the right thing.
 */

describe("checkPasswordPolicy", () => {
  it("accepts a reasonable passphrase", () => {
    expect(checkPasswordPolicy("Correct-Horse-Battery-7")).toBeNull();
    expect(checkPasswordPolicy("t9!Kqm2#vLpZ")).toBeNull();
  });

  it("rejects the denylist verbatim", () => {
    expect(checkPasswordPolicy("password")).not.toBeNull();
    expect(checkPasswordPolicy("qwertyuiop")).not.toBeNull();
    expect(checkPasswordPolicy("iloveyou")).not.toBeNull();
  });

  /**
   * The case a naive denylist misses, and the reason the check runs twice.
   * "Password123" satisfies every length and mixed-case rule people write, and
   * is one of the most common passwords in existence.
   */
  it("rejects a denylisted word wearing digits and punctuation", () => {
    expect(checkPasswordPolicy("Password123")).not.toBeNull();
    expect(checkPasswordPolicy("password1")).not.toBeNull();
    expect(checkPasswordPolicy("welcome!!!")).not.toBeNull();
    expect(checkPasswordPolicy("LetMeIn2024!")).not.toBeNull();
  });

  it("does not strip leading characters, so real passphrases survive", () => {
    // Ends in a denylisted word rather than starting with one — stripping both
    // ends would eat this, and it is a perfectly good password.
    expect(checkPasswordPolicy("xK9-thunder-marmalade")).toBeNull();
  });

  it("rejects a single repeated character", () => {
    expect(checkPasswordPolicy("aaaaaaaaaaaa")).not.toBeNull();
    expect(checkPasswordPolicy("00000000")).not.toBeNull();
  });

  it("rejects sequential runs in both directions", () => {
    expect(checkPasswordPolicy("12345678")).not.toBeNull();
    expect(checkPasswordPolicy("abcdefgh")).not.toBeNull();
    expect(checkPasswordPolicy("87654321")).not.toBeNull();
  });

  it("rejects a password built from the email local part", () => {
    const email = "omkar@example.com";

    expect(checkPasswordPolicy("omkar-2024-xyz", { email })).not.toBeNull();
    expect(checkPasswordPolicy("Omkar-2024-XYZ", { email })).not.toBeNull();
    expect(checkPasswordPolicy("unrelated-nine-tram", { email })).toBeNull();
  });

  it("rejects a password built from the app name, spaces ignored", () => {
    expect(checkPasswordPolicy("myacme-login-4", { appName: "Acme" })).not.toBeNull();
    expect(
      checkPasswordPolicy("TestApp-hunter-9", { appName: "Test App" })
    ).not.toBeNull();
  });

  /**
   * Length is Better Auth's rule (minPasswordLength in auth.factory.ts), not
   * this function's — two sources for one rule would produce two different
   * error messages for the same input.
   */
  it("does not judge length", () => {
    expect(checkPasswordPolicy("xR7#q")).toBeNull();
  });
});

describe("checkImageUrl", () => {
  const secure = { allowInsecure: false };
  const insecure = { allowInsecure: true };

  it("accepts the https URLs OAuth providers hand back", () => {
    expect(
      checkImageUrl("https://lh3.googleusercontent.com/a/ACg8ocK=s96-c", secure)
    ).toBeNull();
  });

  it("treats absent and empty as clearing the avatar, not as an attack", () => {
    expect(checkImageUrl(null, secure)).toBeNull();
    expect(checkImageUrl(undefined, secure)).toBeNull();
    expect(checkImageUrl("", secure)).toBeNull();
    expect(checkImageUrl("   ", secure)).toBeNull();
  });

  /** The finding this whole function exists for. */
  it("rejects script and data schemes", () => {
    expect(checkImageUrl("javascript:alert(1)", secure)).not.toBeNull();
    expect(checkImageUrl("JavaScript:alert(1)", secure)).not.toBeNull();
    expect(checkImageUrl("data:text/html;base64,PHNjcmlwdD4=", secure)).not.toBeNull();
    expect(checkImageUrl("vbscript:msgbox(1)", secure)).not.toBeNull();
    expect(checkImageUrl("file:///etc/passwd", secure)).not.toBeNull();
  });

  it("rejects relative and protocol-relative URLs", () => {
    expect(checkImageUrl("//evil.example/x.png", secure)).not.toBeNull();
    expect(checkImageUrl("/uploads/x.png", secure)).not.toBeNull();
    expect(checkImageUrl("not a url", secure)).not.toBeNull();
  });

  it("rejects http only when insecure URLs are disallowed", () => {
    expect(checkImageUrl("http://localhost:3000/a.png", secure)).not.toBeNull();
    expect(checkImageUrl("http://localhost:3000/a.png", insecure)).toBeNull();
  });

  it("rejects credentials embedded in the URL", () => {
    expect(checkImageUrl("https://user:pw@example.com/a.png", secure)).not.toBeNull();
  });

  it("rejects a non-string and an over-long URL", () => {
    expect(checkImageUrl(42, secure)).not.toBeNull();
    expect(
      checkImageUrl(`https://e.example/${"a".repeat(2100)}.png`, secure)
    ).not.toBeNull();
  });
});
