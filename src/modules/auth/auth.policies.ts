/**
 * ============================================================================
 * Write-time policy for the two user-controlled values Better Auth accepts.
 * ============================================================================
 *
 * These are pure functions on purpose — no Fastify, no Better Auth, no config.
 * The factory wires them in (see auth.factory.ts); this file only decides what
 * is acceptable, which is the half you will actually want to edit per project.
 *
 * Why they exist at all: Better Auth validates *shape*, not *policy*. It
 * enforces that `password` is a string of a given length and that `image` is a
 * string, and stops there. Both values then flow somewhere dangerous — one into
 * the credential store, the other into every frontend that renders a profile —
 * so the boilerplate owns the rules.
 */

/**
 * The 100 or so passwords that appear at the top of every breach corpus, plus
 * the ones people reach for when a form says "at least 8 characters".
 *
 * This is deliberately a list and not a dependency. It is not a substitute for
 * a real breached-credential check — if you are handling anything that matters,
 * put a HaveIBeenPwned k-anonymity lookup in `isBreachedPassword` below, which
 * is the seam left for exactly that. What this list buys you is that the lazy
 * cases ("password", "12345678", "qwerty123") are refused on a fresh clone with
 * no API key and no network call.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "passw0rd",
  "pass",
  "passwd",
  "12345678",
  "123456789",
  "1234567890",
  "123123123",
  "qwerty",
  "qwertyui",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1q2w3e4r",
  "1qaz2wsx",
  "qazwsxedc",
  "abc123",
  "abcd1234",
  "a1b2c3d4",
  "iloveyou",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "root",
  "toor",
  "guest",
  "test",
  "testing",
  "changeme",
  "secret",
  "default",
  "login",
  "master",
  "dragon",
  "monkey",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "basketball",
  "superman",
  "batman",
  "trustno",
  "starwars",
  "computer",
  "internet",
  "whatever",
  "freedom",
  "shadow",
  "michael",
  "jennifer",
  "jordan",
  "hunter",
  "harley",
  "ranger",
  "buster",
  "thomas",
  "robert",
  "matthew",
  "daniel",
  "andrew",
  "joshua",
  "charlie",
  "hello",
  "helloworld",
  "summer",
  "winter",
  "spring",
  "autumn",
  "january",
  "december",
  "samsung",
  "google",
  "facebook",
  "linkedin",
  "twitter",
  "amazon",
  "netflix",
  "spotify",
  "cheese",
  "pepper",
  "ginger",
  "cookie",
  "chocolate",
  "flower",
  "orange",
  "purple",
  "yellow",
  "silver",
  "diamond",
  "money",
  "bailey",
  "soccer",
  "hockey",
  "killer",
  "ashley",
  "nicole",
  "banana",
  "liverpool",
  "arsenal",
  "chelsea",
  "barcelona",
  "juventus",
  "cricket",
  "mustang",
  "corvette",
  "ferrari",
  "porsche",
  "harleydavidson",
]);

/**
 * "password1", "Password123", "welcome!!" and friends all collapse to a word
 * that IS in the list above. Checking only the literal string would let every
 * one of them through, which is how a denylist ends up being decorative.
 *
 * So the check runs twice: once on the lowercased password, and once with
 * trailing digits and punctuation stripped. Leading characters are left alone —
 * stripping both ends starts eating real passphrases.
 */
const trailingPadding = /[\d\W_]+$/;

const isCommonPassword = (password: string): boolean => {
  const lowered = password.toLowerCase();

  if (COMMON_PASSWORDS.has(lowered)) return true;

  const stripped = lowered.replace(trailingPadding, "");

  return stripped.length > 0 && COMMON_PASSWORDS.has(stripped);
};

/** Every character the same — "aaaaaaaa", "00000000". */
const isSingleRepeatedCharacter = (password: string): boolean =>
  password.length > 0 && new Set(password).size === 1;

/**
 * A straight run off the keyboard, forwards or backwards: "12345678",
 * "abcdefgh", "87654321". Checked by code point so it catches the digit runs
 * the denylist does not enumerate.
 */
const isSequentialRun = (password: string): boolean => {
  if (password.length < 4) return false;

  const lowered = password.toLowerCase();
  let ascending = true;
  let descending = true;

  for (let i = 1; i < lowered.length; i += 1) {
    const delta = lowered.charCodeAt(i) - lowered.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }

  return ascending || descending;
};

/**
 * The local part of the address, as a rejectable token. "omkar@example.com"
 * choosing "omkar2024" is the single most common reset-me-later password, and
 * it is the one an attacker who knows the email tries first.
 */
const localPartOf = (email: string): string => (email.split("@")[0] ?? "").toLowerCase();

export interface PasswordContext {
  /** Present on sign-up; absent on reset, where the body carries only a token. */
  email?: string | undefined;
  /** So "Acme2024" is refused in an app called Acme. */
  appName?: string | undefined;
}

/**
 * Returns a human-readable reason the password is unacceptable, or `null` if it
 * passes. Length is NOT checked here — Better Auth already enforces
 * `minPasswordLength` / `maxPasswordLength` from the factory and returns its own
 * error code for it, and duplicating that would produce two different messages
 * for one rule.
 */
export const checkPasswordPolicy = (
  password: string,
  { email, appName }: PasswordContext = {}
): string | null => {
  if (isSingleRepeatedCharacter(password)) {
    return "Password cannot be the same character repeated";
  }

  if (isSequentialRun(password)) {
    return "Password cannot be a sequential run of characters";
  }

  if (isCommonPassword(password)) {
    return "Password is too common — choose something less guessable";
  }

  const lowered = password.toLowerCase();

  if (email) {
    const local = localPartOf(email);
    if (local.length >= 3 && lowered.includes(local)) {
      return "Password cannot contain your email address";
    }
  }

  if (appName) {
    const app = appName.toLowerCase().replace(/\s+/g, "");
    if (app.length >= 3 && lowered.includes(app)) {
      return "Password cannot contain the application name";
    }
  }

  return null;
};

/**
 * The seam for a real breached-credential check.
 *
 * Left as a resolved `false` rather than wired to a service, because a
 * boilerplate should not make an outbound HTTPS call on every sign-up without
 * being asked. To turn it on, implement the HaveIBeenPwned range API here — you
 * send the first five characters of the SHA-1 of the password and compare
 * suffixes locally, so the password itself never leaves the process:
 *
 * ```ts
 * const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
 * const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
 * return (await res.text()).includes(sha1.slice(5));
 * ```
 *
 * Fail OPEN if that request errors. A password service being down is not a
 * reason nobody can register.
 */
export const isBreachedPassword = async (_password: string): Promise<boolean> =>
  Promise.resolve(false);

/**
 * ----------------------------------------------------------------------------
 * Profile image
 * ----------------------------------------------------------------------------
 *
 * `image` is the one profile field a user can set to an arbitrary string, and
 * it is the one that gets rendered by every client. Better Auth types it as
 * `string | null` and stores whatever it is given, which means without this
 * check `POST /api/auth/update-user` happily persists `javascript:alert(1)` —
 * harmless in an `<img src>`, not harmless in an `<a href>` or a CSS `url()`,
 * and an SSRF source the moment any backend job fetches it to make a thumbnail.
 *
 * OAuth sign-in also writes this field, with an https URL from the provider, so
 * the policy has to keep those working — it does.
 */
const MAX_IMAGE_URL_LENGTH = 2048;

export interface ImageUrlOptions {
  /**
   * Whether to accept `http:` as well as `https:`. False in production. Local
   * avatar fixtures are served over http and blocking them in development buys
   * nothing, but a plaintext image URL in a production profile is a mixed-content
   * warning at best.
   */
  allowInsecure: boolean;
}

/**
 * Returns a reason the image URL is unacceptable, or `null` if it passes.
 * `null` input is fine — clearing your avatar is not an attack.
 */
export const checkImageUrl = (
  value: unknown,
  { allowInsecure }: ImageUrlOptions
): string | null => {
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") return "Profile image must be a URL string";

  const trimmed = value.trim();

  if (trimmed === "") return null;

  if (trimmed.length > MAX_IMAGE_URL_LENGTH) {
    return `Profile image URL cannot be longer than ${MAX_IMAGE_URL_LENGTH} characters`;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    // Relative paths, "javascript:alert(1)" without a valid structure, and
    // protocol-relative "//evil.example" all land here.
    return "Profile image must be an absolute http(s) URL";
  }

  // An allow-list, never a deny-list: `data:`, `javascript:`, `vbscript:`,
  // `file:` and whatever the next browser ships are all refused by not being
  // named, rather than by being remembered.
  const allowed = allowInsecure ? ["https:", "http:"] : ["https:"];

  if (!allowed.includes(url.protocol)) {
    return allowInsecure
      ? "Profile image must be an http(s) URL"
      : "Profile image must be an https URL";
  }

  // Credentials in a URL that will be rendered in an <img> tag are either a
  // mistake or an attempt to leak them into a referrer log.
  if (url.username !== "" || url.password !== "") {
    return "Profile image URL cannot contain credentials";
  }

  return null;
};
