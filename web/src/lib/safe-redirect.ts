/**
 * Sanitises a `?next=` parameter before it is used as a redirect target.
 *
 * The sign-in page reads where to go back to from the query string, which is
 * attacker-controlled by definition — a link like
 * `/sign-in?next=https://evil.example` is the entire open-redirect bug, and it
 * is worth more than usual here because the page it decorates is the one where
 * people type passwords.
 *
 * The rule is deliberately blunt: a target must start with a single `/` and not
 * a second one. `//evil.example` is a protocol-relative URL that browsers treat
 * as absolute, and it is the case every hand-rolled check misses.
 *
 * Two subtler cases the prefix checks alone do NOT cover, both of which resolve
 * off-origin once a browser gets hold of them:
 *
 *   - Control characters. The URL parser strips tab (U+0009), newline (U+000A)
 *     and CR (U+000D) BEFORE parsing, so a target that starts with a single `/`
 *     followed by a tab and `//evil.example` passes every prefix test yet
 *     becomes `//evil.example` and resolves to `https://evil.example`. It
 *     arrives as `?next=/%09//evil.example`, because `useSearchParams`
 *     percent-decodes `%09` back to a tab.
 *   - Any backslash, not only a leading one. Browsers normalise `\` to `/`, so
 *     `/\evil.example` and `/x/\evil.example` are both absolute-ish once parsed.
 *
 * So reject anything carrying a control character or a backslash outright, then
 * apply the prefix rule to what remains.
 */
const BACKSLASH = 0x5c;
const DELETE = 0x7f;
const FIRST_PRINTABLE = 0x20;

/** True if the string holds a char a browser would strip or rewrite pre-parse. */
function hasUnsafeChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // C0 controls (tab/newline/CR among them), DEL, and any backslash. A guard
    // on the pre-parse string is blind to what the URL parser drops or rewrites,
    // so refuse the whole value rather than try to prove where it lands.
    if (code < FIRST_PRINTABLE || code === DELETE || code === BACKSLASH) {
      return true;
    }
  }
  return false;
}

export function safeRedirect(target: string | null | undefined, fallback = "/"): string {
  if (!target) return fallback;
  if (hasUnsafeChar(target)) return fallback;
  if (!target.startsWith("/")) return fallback;
  if (target.startsWith("//")) return fallback;

  return target;
}
