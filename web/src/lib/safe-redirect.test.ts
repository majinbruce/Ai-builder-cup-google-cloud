import { describe, it, expect } from "vitest";
import { safeRedirect } from "./safe-redirect";

/**
 * `safeRedirect` guards the `?next=` param on the sign-in page — an open-redirect
 * sink by definition. These lock in the two classes that defeat a naive prefix
 * check: control characters the URL parser strips before parsing, and
 * backslashes browsers normalise to `/`.
 */
describe("safeRedirect", () => {
  it("allows same-origin absolute paths", () => {
    expect(safeRedirect("/dashboard")).toBe("/dashboard");
    expect(safeRedirect("/settings?tab=profile")).toBe("/settings?tab=profile");
    expect(safeRedirect("/a/b/c#frag")).toBe("/a/b/c#frag");
  });

  it("falls back for empty or missing input", () => {
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("")).toBe("/");
    expect(safeRedirect(null, "/dashboard")).toBe("/dashboard");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("http://evil.example")).toBe("/");
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("not-a-path")).toBe("/");
  });

  it("rejects backslashes anywhere, not just leading", () => {
    // Browsers normalise `\` to `/`, so both of these resolve off-origin.
    expect(safeRedirect("/\\evil.example")).toBe("/");
    expect(safeRedirect("/legit/\\evil.example")).toBe("/");
  });

  it("rejects control characters the URL parser strips before parsing", () => {
    // The live payload: `?next=/%09//evil.example` decodes to a tab, which would
    // slip past a `//` prefix check and then be stripped into `//evil.example`.
    const tab = String.fromCharCode(0x09);
    const newline = String.fromCharCode(0x0a);
    const cr = String.fromCharCode(0x0d);
    expect(safeRedirect(`/${tab}//evil.example`)).toBe("/");
    expect(safeRedirect(`/${newline}//evil.example`)).toBe("/");
    expect(safeRedirect(`/${cr}//evil.example`)).toBe("/");
    expect(safeRedirect(`/${String.fromCharCode(0x7f)}x`)).toBe("/");
  });
});
