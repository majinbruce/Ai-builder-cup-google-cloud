import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { Resend } from "resend";
import { config } from "../config/index.ts";

/**
 * The whole email surface of this boilerplate, deliberately tiny.
 *
 * Better Auth never sends email itself — it hands you a fully-formed URL and a
 * token in a callback and lets you decide what to do with them (see
 * modules/auth/auth.factory.ts). That means the choice of provider is ours, and
 * the only thing the rest of the code needs to agree on is this interface.
 *
 * Keeping it an interface rather than a concrete client is what makes the
 * dev-mode console implementation, the Resend implementation below and the
 * test fake interchangeable — and it is why the tests can read a verification
 * token straight out of a message without anything pretending to be a mail
 * server. Swapping Resend for SES or Postmark is one new `Mailer` here plus
 * one arm in `createMailer`; nothing else in the app changes.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  /**
   * Required, never optional. Some clients render text by preference, some
   * users force it, and an HTML-only message scores worse with spam filters.
   * It must carry the same link the HTML does.
   */
  text: string;
  /** Set for real templates; see modules/auth/auth.emails.ts. */
  html?: string;
}

export interface Mailer {
  /**
   * The sender address is the implementation's business, not the caller's —
   * it is transport configuration, and providers differ on whether it is
   * per-message or per-account. Implementations should use
   * `config.mail.from`.
   */
  send(message: EmailMessage): Promise<void>;
}

/**
 * The default implementation: log the message and move on.
 *
 * A boilerplate that requires an API key before you can register your first
 * user is a boilerplate you cannot run. This makes the verification and reset
 * flows fully exercisable on a fresh clone with no external account — you copy
 * the link out of the terminal.
 *
 * It logs through Fastify's logger rather than console.log for two reasons:
 * the `no-console` lint rule, and so the line carries the same reqId as the
 * request that triggered it.
 */
export const createConsoleMailer = (log: FastifyBaseLogger): Mailer => ({
  send: async ({ to, subject, text, html }) => {
    // The plain-text body is logged, not the HTML: the point of this in
    // development is that you can read the message and click the link out of
    // your terminal, and a wall of table markup defeats that.
    log.info(
      {
        from: config.mail.from,
        to,
        subject,
        hasHtml: html !== undefined,
        body: text,
      },
      "email-not-sent (console mailer — configure a real Mailer for production)"
    );
  },
});

/**
 * The subset of the Resend SDK this file uses.
 *
 * Declared structurally rather than importing the client type so the unit tests
 * can pass a stub with one method on it. `new Resend(...)` satisfies it, and if
 * the SDK's payload ever drifts, `createResendMailer`'s default argument stops
 * compiling — which is the point of not typing this as `any`.
 */
export interface ResendEmailsClient {
  emails: {
    send(
      payload: {
        from: string;
        to: string;
        subject: string;
        text: string;
        html?: string;
        replyTo?: string;
      },
      options?: { idempotencyKey?: string }
    ): Promise<{
      data: { id: string } | null;
      error: { message: string; name: string; statusCode: number | null } | null;
    }>;
  };
}

export interface ResendMailerOptions {
  log: FastifyBaseLogger;
  /** Overridden by the tests; defaults to a client built from config. */
  client?: ResendEmailsClient;
  /**
   * Total attempts, including the first. Retries are bounded and short on
   * purpose: this runs inside the HTTP request that triggered the email (a
   * sign-up, a reset request), so a long retry loop is a request that hangs.
   */
  attempts?: number;
  /** Doubles each attempt. 0 in the tests, so they do not sleep. */
  baseDelayMs?: number;
  /**
   * Per-attempt ceiling. Node's fetch will wait minutes on a stalled
   * connection, and this call sits inside the sign-up request — without a bound
   * a provider that hangs turns into requests that hang.
   *
   * 5s rather than something roomier because it multiplies: three attempts plus
   * backoff is a worst case of roughly 16s that a user spends staring at a
   * pending sign-up. Resend answers in well under a second in practice, so a
   * request still running at 5s is not slow, it is gone.
   */
  timeoutMs?: number;
}

/**
 * The Resend error codes worth trying again.
 *
 * The distinction is whether a second identical request could plausibly
 * succeed. A 429 or a 5xx is the provider having a moment; `validation_error`
 * or `invalid_from_address` is our bug and will fail identically forever, so
 * retrying it only delays the error the caller needs to see.
 *
 * Quota errors are deliberately absent: `daily_quota_exceeded` does not clear
 * within the lifetime of one request.
 */
const RETRYABLE_ERROR_NAMES = new Set([
  "rate_limit_exceeded",
  "internal_server_error",
  "application_error",
  // Not a Resend code — what this file labels a thrown request (DNS, a dropped
  // socket, a timeout). It carries no status code, so it needs the name.
  "network_error",
  /**
   * 409, and the direct consequence of the timeout above: the abandoned
   * attempt is still in flight at Resend when the retry arrives with the same
   * idempotency key. Treating it as permanent would report failure for a
   * message that is, at that very moment, being delivered. Retried, it
   * eventually returns the original request's stored response.
   */
  "concurrent_idempotent_requests",
]);

/**
 * Checked before the status code, because these come back as 429 and would
 * otherwise be mistaken for a rate limit. A monthly or daily quota does not
 * refill inside one HTTP request.
 */
const PERMANENT_ERROR_NAMES = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);

const isRetryable = (error: { name: string; statusCode: number | null }): boolean => {
  if (PERMANENT_ERROR_NAMES.has(error.name)) return false;

  return (
    RETRYABLE_ERROR_NAMES.has(error.name) ||
    error.statusCode === 429 ||
    (error.statusCode !== null && error.statusCode >= 500)
  );
};

/**
 * Resolves the promise, or rejects once `ms` has passed.
 *
 * The abandoned request keeps running — the SDK takes no AbortSignal, so there
 * is nothing to cancel. That is deliberate rather than sloppy: the retry sends
 * the same idempotency key, so if the abandoned attempt did reach Resend, the
 * retry is deduped instead of delivering a second copy.
 *
 * Racing a promise against a timer is where this goes wrong quietly, in two
 * ways, and both are load-bearing here:
 *
 *   - **The loser of the race still settles.** An abandoned request usually
 *     ends up rejecting afterwards, long after the caller has moved on. That
 *     stays contained here — `Promise.race` subscribes to every input, so the
 *     late rejection is handled rather than becoming an unhandled rejection,
 *     which Node treats as fatal. It is contained *incidentally* though, so the
 *     rejection is caught explicitly below rather than left to that detail: it
 *     also lets the real error be rethrown instead of a timeout, and it does
 *     not quietly become a crash the day someone rewrites this race.
 *   - **The timer outlives the race.** A pending `setTimeout` holds the event
 *     loop open, so every failed attempt would keep the process alive for the
 *     rest of its timeout. It is created with `ref: false` and cancelled on the
 *     way out — on the throwing paths too, hence the `finally`.
 */
type TimedRace<T> =
  | { timedOut: true }
  | { timedOut: false; ok: true; value: T }
  | { timedOut: false; ok: false; cause: unknown };

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  const abandon = new AbortController();

  // Both outcomes get a handler here, so `promise` is never left unhandled.
  // A rejection is carried through the race as a value and rethrown below, so
  // the caller still catches the real error rather than a timeout.
  const settled: Promise<TimedRace<T>> = promise.then(
    (value) => ({ timedOut: false, ok: true, value }),
    (cause: unknown) => ({ timedOut: false, ok: false, cause })
  );

  const timer: Promise<TimedRace<T>> = sleep(
    ms,
    { timedOut: true } as const,
    // ref: false — a timer for a request that already came back must not be a
    // reason for the process to stay alive.
    { signal: abandon.signal, ref: false }
    // Aborted because the send won the race. Returning a promise that never
    // settles rather than a value keeps this branch out of the race it already
    // lost, and keeps the abort from surfacing as an unhandled rejection.
  ).catch(() => new Promise<never>(() => {}));

  try {
    const outcome = await Promise.race([settled, timer]);

    if (outcome.timedOut) throw new Error(`no response after ${ms}ms`);
    if (!outcome.ok) throw outcome.cause;

    return outcome.value;
  } finally {
    abandon.abort();
  }
};

/**
 * The production implementation.
 *
 * Three things here are not obvious and all three matter:
 *
 * 1. The SDK does not throw on an API error — it resolves with `{ data, error }`
 *    and returns `error` as a value. An implementation that only wraps the call
 *    in try/catch therefore reports every rejected send as a success, and the
 *    first sign of trouble is a user saying they never got the email.
 *
 * 2. Retries reuse ONE idempotency key per message. Resend dedupes on it for
 *    24h, so a request that actually reached them but failed on the way back
 *    cannot produce a second copy of the same verification email.
 *
 * 3. Every attempt is bounded by a timeout. The SDK exposes no cancellation
 *    hook, so a hung request is abandoned rather than aborted — which is safe
 *    only because of (2): the retry carries the same idempotency key, so a
 *    request that was actually delivered while we stopped waiting cannot
 *    produce a second copy. Verified against the live API: three abandoned
 *    in-flight attempts sharing one key produced exactly one delivered email.
 *
 *    The corollary is that a timeout makes failure reporting one-sided. This
 *    can log "delivery failed" for a message the provider went on to deliver,
 *    because there is no way to tell an abandoned request that failed from one
 *    that succeeded after we stopped listening. At-most-once is the property
 *    being defended here; the log line means "we did not see it land".
 *
 * Giving up logs at ERROR and then throws. The throw is for the caller;
 * the log line is the one that matters operationally, because **Better Auth
 * swallows this error on sign-up** — `POST /sign-up/email` returns 200 whether
 * or not the verification email went out. That is Better Auth's behaviour, not
 * something this file can change, so "email delivery failed" is the event to
 * alert on. The user's recourse is `POST /send-verification-email`, which does
 * surface the failure (500).
 */
export const createResendMailer = ({
  log,
  client,
  attempts = 3,
  baseDelayMs = 250,
  timeoutMs = 5_000,
}: ResendMailerOptions): Mailer => {
  if (client === undefined && config.mail.resendApiKey === null) {
    /**
     * Reachable only by calling this factory directly with MAIL_PROVIDER unset
     * — `createMailer` cannot get here, because config refuses to boot with
     * MAIL_PROVIDER=resend and no key. Worth its own error anyway: the SDK
     * accepts a missing key at construction and only complains at send time,
     * which turns a startup mistake into a runtime one.
     */
    throw new Error(
      "createResendMailer: RESEND_API_KEY is not configured (pass `client` to inject one)"
    );
  }

  const resend: ResendEmailsClient =
    client ?? new Resend(config.mail.resendApiKey ?? undefined);

  return {
    send: async ({ to, subject, text, html }) => {
      const idempotencyKey = randomUUID();
      let lastError = "";
      // Attempts actually made, which is not `attempts` when the loop broke
      // early on an error no retry could fix — the thrown message says which.
      let made = 0;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let failure: { message: string; name: string; statusCode: number | null };
        made = attempt;

        try {
          const { data, error } = await withTimeout(
            resend.emails.send(
              {
                from: config.mail.from,
                to,
                subject,
                text,
                // `exactOptionalPropertyTypes`: an absent key and a key set to
                // undefined are different types, hence the spreads.
                ...(html === undefined ? {} : { html }),
                ...(config.mail.replyTo === undefined
                  ? {}
                  : { replyTo: config.mail.replyTo }),
              },
              { idempotencyKey }
            ),
            timeoutMs
          );

          if (!error) {
            log.info({ to, subject, providerMessageId: data?.id, attempt }, "email sent");
            return;
          }

          failure = error;
        } catch (cause) {
          // A thrown error here is the network, not the API: DNS, a dropped
          // socket, a timeout. Always worth one more attempt.
          failure = {
            message: cause instanceof Error ? cause.message : String(cause),
            name: "network_error",
            statusCode: null,
          };
        }

        lastError = `${failure.name}: ${failure.message}`;
        const willRetry = attempt < attempts && isRetryable(failure);

        log.warn(
          {
            to,
            subject,
            attempt,
            attempts,
            errorName: failure.name,
            statusCode: failure.statusCode,
            // The message, not the error object: Resend error payloads are
            // provider-shaped and this keeps the log line predictable.
            reason: failure.message,
            willRetry,
          },
          "email send failed"
        );

        if (!willRetry) break;

        // Exponential, with jitter so a provider blip does not turn every
        // in-flight request into a synchronised second wave.
        await sleep(baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random()));
      }

      /**
       * ERROR, not another warn: this is the line to alert on. Better Auth
       * swallows a sendVerificationEmail failure and still answers sign-up with
       * 200, so without this log line an account that can never be activated
       * leaves no trace anywhere.
       */
      log.error(
        { to, subject, attempts: made, reason: lastError },
        "email delivery failed — giving up"
      );

      // The recipient is in the message, never in the thrown text: this string
      // can reach a client, and email addresses do not belong in error bodies.
      throw new Error(
        `Resend refused the message after ${made} attempt(s): ${lastError}`
      );
    },
  };
};

/**
 * Builds the Mailer the app runs with. This is the only place the provider
 * choice is made, and it is made from configuration — so `MAIL_PROVIDER=resend`
 * plus a key is the entire production switch-over, with no code edit.
 */
export const createMailer = (log: FastifyBaseLogger): Mailer =>
  config.mail.provider === "resend"
    ? createResendMailer({ log })
    : createConsoleMailer(log);
