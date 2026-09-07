import { z } from "zod";

/**
 * ============================================================================
 * The API's response envelope, mirrored on this side of the wire.
 * ============================================================================
 *
 * The Fastify app answers every `/api/v1/*` route with one of three shapes
 * (see the backend's src/lib/api-response.ts). Parsing them in one place means
 * a route handler that changes shape fails HERE, with a readable error naming
 * the field, instead of as `undefined` rendered into a component three layers
 * away.
 *
 * `/api/auth/*` is the documented exception: Better Auth uses its own shape and
 * its client SDK parses it. Nothing in this file applies there.
 */
export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({
    statusCode: z.literal(0),
    message: z.string(),
    data,
  });

export const paginatedEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({
    statusCode: z.literal(0),
    message: z.string(),
    data: z.array(item),
    meta: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });

export const errorDetailSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.object({
  statusCode: z.literal(-1),
  message: z.string(),
  requestId: z.string().optional(),
  details: z.array(errorDetailSchema).optional(),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Every non-2xx from the API, and every response that did not parse, arrives as
 * one of these.
 *
 * `requestId` is the value the API put in the `x-request-id` header and in its
 * own log line — quoting it in a bug report turns "it broke" into one grep on
 * the server.
 *
 * `details` is the per-field list a Zod validation failure produces. Forms feed
 * it straight into react-hook-form's `setError`; see `applyFieldErrors`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly details: ErrorDetail[];
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      status: number;
      details?: ErrorDetail[];
      requestId?: string | undefined;
    }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.details = options.details ?? [];
    this.requestId = options.requestId;
  }

  /** 401 — not signed in, or the session was revoked/expired server-side. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 403 — signed in, but the role does not allow it. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/**
 * Turns a `Response` into either parsed data or a thrown `ApiError`.
 *
 * Shared by the browser and the server callers so the two cannot drift; the
 * only thing they do differently is build the request.
 */
export async function parseResponse<T extends z.ZodType>(
  response: Response,
  schema: T
): Promise<z.infer<T>> {
  const requestId = response.headers.get("x-request-id") ?? undefined;

  // A 502 from a proxy, or a crash before the error handler ran, is HTML.
  // Reading it as JSON throws a SyntaxError that says nothing useful.
  const raw: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(raw);

    throw new ApiError(
      parsed.success ? parsed.data.message : `Request failed (${response.status})`,
      {
        status: response.status,
        ...(parsed.success && parsed.data.details !== undefined
          ? { details: parsed.data.details }
          : {}),
        requestId: parsed.success ? (parsed.data.requestId ?? requestId) : requestId,
      }
    );
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    // A 200 the client cannot read is a bug on one side or the other, and it
    // should be as loud as a 500.
    throw new ApiError("The API returned a response this client cannot read", {
      status: response.status,
      requestId,
    });
  }

  return parsed.data;
}
