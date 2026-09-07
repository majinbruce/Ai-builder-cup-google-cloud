import type { UseFormSetError, FieldValues, Path } from "react-hook-form";
import { ApiError } from "@/lib/api/envelope";

/**
 * ============================================================================
 * Turning a failed request into something a user can act on.
 * ============================================================================
 *
 * Two error shapes reach the UI, from two different parts of the API:
 *
 *   1. Better Auth (`/api/auth/*`) answers `{ code, message }` and the client
 *      SDK hands it back as `{ error: { code, message, status } }` — never a
 *      thrown exception. `code` is a stable string; `message` is not, so branch
 *      on the code and treat the message as a fallback.
 *
 *   2. Everything else (`/api/v1/*`) throws an `ApiError` carrying the house
 *      envelope's `details[]` — one `{ field, message }` per failed Zod check.
 *
 * Both end up in the same place: a message under the field that caused it,
 * because a validation failure shown as a toast is a validation failure the
 * user has to guess at.
 */

/** The shape Better Auth's client returns in `{ error }`. */
export interface AuthClientError {
  code?: string | undefined;
  message?: string | undefined;
  status?: number;
}

/**
 * Codes worth rewording. Better Auth's own messages are accurate but written
 * for a developer; these are written for whoever is looking at the form.
 *
 * WEAK_PASSWORD is ours — the API raises it from the password policy hook in
 * auth.factory.ts specifically so this layer can put the reason on the password
 * field. Its message is already user-facing, so it is passed through.
 */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password do not match an account.",
  USER_ALREADY_EXISTS: "An account with that email already exists.",
  EMAIL_NOT_VERIFIED: "Verify your email address before signing in.",
  INVALID_TOKEN: "That link is invalid or has expired. Request a new one.",
  PASSWORD_TOO_SHORT: "Password must be at least 8 characters.",
  PASSWORD_TOO_LONG: "Password cannot be longer than 128 characters.",
  SESSION_EXPIRED: "Your session expired. Sign in again.",
};

/** Which form field a given auth error belongs against, if any. */
const AUTH_ERROR_FIELD: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "password",
  USER_ALREADY_EXISTS: "email",
  EMAIL_NOT_VERIFIED: "email",
  WEAK_PASSWORD: "password",
  PASSWORD_TOO_SHORT: "password",
  PASSWORD_TOO_LONG: "password",
};

export function authErrorMessage(error: AuthClientError | null | undefined): string {
  if (!error) return "Something went wrong. Try again.";

  if (error.code && error.code in AUTH_MESSAGES) {
    return AUTH_MESSAGES[error.code] as string;
  }

  // 429 is the rate limiter in auth.factory.ts (5 sign-ins a minute, 3 reset
  // requests). Saying so is more useful than "Too many requests".
  if (error.status === 429) {
    return "Too many attempts. Wait a minute and try again.";
  }

  return error.message ?? "Something went wrong. Try again.";
}

/**
 * Puts a Better Auth failure on the field it belongs to, and returns whether it
 * found one. `false` means the caller should show it as a toast instead.
 */
export function applyAuthError<T extends FieldValues>(
  error: AuthClientError | null | undefined,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[]
): boolean {
  if (!error?.code) return false;

  const field = AUTH_ERROR_FIELD[error.code];

  if (!field || !fields.includes(field as Path<T>)) return false;

  setError(field as Path<T>, { type: "server", message: authErrorMessage(error) });
  return true;
}

/**
 * The same job for an `ApiError` from `/api/v1/*`: every `details[]` entry
 * whose `field` exists on the form becomes an inline message. Returns whether
 * anything was placed, so the caller knows whether to also toast.
 */
export function applyFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[]
): boolean {
  if (!(error instanceof ApiError) || error.details.length === 0) return false;

  let placed = false;

  for (const detail of error.details) {
    if (!fields.includes(detail.field as Path<T>)) continue;
    setError(detail.field as Path<T>, { type: "server", message: detail.message });
    placed = true;
  }

  return placed;
}
