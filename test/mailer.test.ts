import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config/index.ts";
import { createResendMailer, type ResendEmailsClient } from "../src/lib/mailer.ts";

/**
 * The Resend implementation, with the SDK stubbed. What is worth pinning here
 * is not "does it call send" but the three things that are silently wrong in
 * most hand-rolled provider adapters: an API error returned as a VALUE rather
 * than thrown, a retry that duplicates the message, and a retry loop that runs
 * on errors which can never succeed.
 */

type SendResult = Awaited<ReturnType<ResendEmailsClient["emails"]["send"]>>;
type SendArgs = Parameters<ResendEmailsClient["emails"]["send"]>;

const ok = (id = "msg_1"): SendResult => ({ data: { id }, error: null });

const failure = (
  name: string,
  statusCode: number | null,
  message = "nope"
): SendResult => ({ data: null, error: { name, message, statusCode } });

/** Returns the queued results in order; the last one repeats if it runs out. */
const stubClient = (...results: (SendResult | Error)[]) => {
  const calls: SendArgs[] = [];
  let index = 0;

  const client: ResendEmailsClient = {
    emails: {
      send: async (...args) => {
        calls.push(args);
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (result instanceof Error) throw result;
        return result ?? ok();
      },
    },
  };

  return { client, calls };
};

// baseDelayMs 0 everywhere: the retry policy is under test, not the clock.
const build = (client: ResendEmailsClient, { attempts = 3, timeoutMs = 10_000 } = {}) => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mailer = createResendMailer({
    log: log as never,
    client,
    attempts,
    baseDelayMs: 0,
    timeoutMs,
  });

  return Object.assign(mailer, { log });
};

const MESSAGE = {
  to: "ada@example.com",
  subject: "Verify your email",
  text: "Open https://api.example.com/verify?token=abc",
  html: "<p>Open</p>",
};

describe("resend mailer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the message onto the provider payload", async () => {
    const { client, calls } = stubClient(ok());

    await build(client).send(MESSAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      from: config.mail.from,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it("omits html rather than sending undefined when a message is text-only", async () => {
    const { client, calls } = stubClient(ok());

    const { html: _html, ...textOnly } = MESSAGE;
    await build(client).send(textOnly);

    expect(calls[0]?.[0]).not.toHaveProperty("html");
  });

  it("throws when the API returns an error instead of throwing one", async () => {
    // The failure mode this exists to prevent: the SDK resolves successfully
    // with `error` set, so an adapter that only catches sees a sent email.
    const { client } = stubClient(failure("validation_error", 422));

    await expect(build(client).send(MESSAGE)).rejects.toThrow(/validation_error/);
  });

  it("does not leak the recipient into the thrown message", async () => {
    const { client } = stubClient(failure("validation_error", 422));

    await expect(build(client).send(MESSAGE)).rejects.not.toThrow(new RegExp(MESSAGE.to));
  });

  it("retries a 5xx and resolves once a later attempt succeeds", async () => {
    const { client, calls } = stubClient(failure("internal_server_error", 500), ok());

    await expect(build(client).send(MESSAGE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("retries a rate limit and a network throw", async () => {
    const rateLimited = stubClient(failure("rate_limit_exceeded", 429), ok());
    await expect(build(rateLimited.client).send(MESSAGE)).resolves.toBeUndefined();
    expect(rateLimited.calls).toHaveLength(2);

    const flaky = stubClient(new Error("ECONNRESET"), ok());
    await expect(build(flaky.client).send(MESSAGE)).resolves.toBeUndefined();
    expect(flaky.calls).toHaveLength(2);
  });

  it("does NOT retry an error a second identical request cannot fix", async () => {
    for (const error of [
      failure("validation_error", 422),
      failure("invalid_from_address", 403),
      failure("daily_quota_exceeded", 429),
    ]) {
      const { client, calls } = stubClient(error);

      await expect(build(client).send(MESSAGE)).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
  });

  it("stops after the configured number of attempts", async () => {
    const { client, calls } = stubClient(failure("internal_server_error", 500));

    await expect(build(client, { attempts: 2 }).send(MESSAGE)).rejects.toThrow(
      /2 attempt/
    );
    expect(calls).toHaveLength(2);
  });

  it("reuses one idempotency key across retries, so a retry cannot duplicate the email", async () => {
    const { client, calls } = stubClient(failure("internal_server_error", 500), ok());

    await build(client).send(MESSAGE);

    const keys = calls.map(([, options]) => options?.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("gives up on a provider that hangs, instead of hanging with it", async () => {
    // No response ever. Without a per-attempt ceiling this send — and the
    // sign-up request it runs inside — waits on Node's fetch defaults.
    const client: ResendEmailsClient = { emails: { send: () => new Promise(() => {}) } };

    await expect(
      build(client, { attempts: 1, timeoutMs: 20 }).send(MESSAGE)
    ).rejects.toThrow(/no response after 20ms/);
  });

  it("logs at ERROR when it gives up, because sign-up still answers 200", async () => {
    // Better Auth swallows a failed sendVerificationEmail, so this log line is
    // the only trace that an account was created it can never verify.
    const { client } = stubClient(failure("validation_error", 422));
    const mailer = build(client);

    await expect(mailer.send(MESSAGE)).rejects.toThrow();
    expect(mailer.log.error).toHaveBeenCalledTimes(1);
  });

  it("retries `concurrent_idempotent_requests`, which its own timeout causes", async () => {
    // The abandoned attempt is still in flight at Resend when the retry lands
    // with the same key. Reported as permanent, this would announce failure for
    // a message that is being delivered at that moment.
    const { client, calls } = stubClient(
      failure("concurrent_idempotent_requests", 409),
      ok()
    );

    await expect(build(client).send(MESSAGE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("times out one attempt and succeeds on the retry, without a new key", async () => {
    const calls: SendArgs[] = [];
    let call = 0;
    const client: ResendEmailsClient = {
      emails: {
        send: async (...args) => {
          calls.push(args);
          call += 1;
          if (call === 1) return new Promise<never>(() => {});
          return ok();
        },
      },
    };

    await expect(
      build(client, { attempts: 2, timeoutMs: 20 }).send(MESSAGE)
    ).resolves.toBeUndefined();

    // Same key: the abandoned request is not cancelled, so this is the only
    // thing standing between a timeout and two verification emails.
    expect(calls[1]?.[1]?.idempotencyKey).toBe(calls[0]?.[1]?.idempotencyKey);
  });

  it("does not crash the process when an abandoned request rejects later", async () => {
    /**
     * An abandoned request almost always rejects afterwards, long after the
     * caller gave up — and an unhandled rejection is fatal in Node by default.
     * This passes today because `Promise.race` subscribes to every input, so
     * the late rejection is handled incidentally; the test is here so that
     * stops being incidental. Rewrite the race without keeping a handler on the
     * abandoned promise and a slow provider starts killing the process.
     */
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const client: ResendEmailsClient = {
        emails: {
          send: () =>
            new Promise((_resolve, reject) => {
              setTimeout(
                () => reject(new Error("ECONNRESET, long after we gave up")),
                30
              );
            }),
        },
      };

      await expect(
        build(client, { attempts: 1, timeoutMs: 5 }).send(MESSAGE)
      ).rejects.toThrow(/no response after 5ms/);

      // Past the point where the abandoned request rejects.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("cancels the timeout timer on the failure path too", async () => {
    // A live timer keeps the event loop open. Left uncancelled, every failed
    // send would hold the process up for the rest of its timeout.
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const { client } = stubClient(new Error("ECONNRESET"));

    await expect(
      build(client, { attempts: 2, timeoutMs: 60_000 }).send(MESSAGE)
    ).rejects.toThrow();

    // One per attempt, none skipped by the throw.
    expect(abort.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to be constructed without a key or an injected client", async () => {
    // config in the test env has no key; the SDK would accept that silently and
    // only fail at send time.
    expect(() => createResendMailer({ log: { info: vi.fn() } as never })).toThrow(
      /RESEND_API_KEY is not configured/
    );
  });

  it("uses a different idempotency key for a different message", async () => {
    const { client, calls } = stubClient(ok());
    const mailer = build(client);

    await mailer.send(MESSAGE);
    await mailer.send(MESSAGE);

    expect(calls[1]?.[1]?.idempotencyKey).not.toBe(calls[0]?.[1]?.idempotencyKey);
  });
});
