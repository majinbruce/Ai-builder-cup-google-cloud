import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  passwordResetEmail,
  verificationEmail,
} from "../src/modules/auth/auth.emails.ts";

/**
 * Pure functions, so no app and no database. The claims worth pinning are the
 * ones that are easy to break silently while editing copy.
 */
const TEMPLATES = [
  { name: "verification", build: verificationEmail },
  { name: "password reset", build: passwordResetEmail },
] as const;

describe("auth email templates", () => {
  const url = "https://api.example.com/api/auth/verify-email?token=abc123";

  describe.each(TEMPLATES)("$name", ({ build }) => {
    const email = build({ name: "Ada Lovelace", url });

    it("has a subject", () => {
      expect(email.subject.length).toBeGreaterThan(0);
    });

    it("carries the link in BOTH the html and the plain text", () => {
      // The text half is not decoration: some clients render it by preference,
      // and a template that only links from the HTML strands those users.
      expect(email.html).toContain(url);
      expect(email.text).toContain(url);
    });

    it("prints the raw url as a fallback, not only inside the button", () => {
      // Corporate mail scanners rewrite or strip <a> hrefs; the visible URL is
      // the user's only recourse when that happens.
      const withoutHref = email.html.replace(/href="[^"]*"/g, "");
      expect(withoutHref).toContain(url);
    });

    it("greets the user by name", () => {
      expect(email.text).toContain("Ada Lovelace");
    });

    it("keeps the plain text free of markup", () => {
      expect(email.text).not.toMatch(/<[a-z/]/i);
    });

    it("uses the configured app name", () => {
      expect(email.text).toContain("Test App");
    });
  });

  it("escapes a hostile display name instead of injecting it", () => {
    // `name` is whatever the user typed at sign-up, and account linking means
    // it can reach an inbox that is not theirs.
    const email = verificationEmail({
      name: "<script>alert(1)</script>",
      url,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("escapes the five characters that break out of html", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("falls back to a bare greeting when the name is blank", () => {
    const email = verificationEmail({ name: "   ", url });
    expect(email.text.startsWith("Hi,")).toBe(true);
  });
});
