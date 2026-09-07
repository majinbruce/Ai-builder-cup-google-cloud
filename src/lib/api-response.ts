import { z } from "zod";

/**
 * One response shape for the whole API, so clients never have to branch on
 * which endpoint they called.
 *
 *   { statusCode: 0,  message, data }       -> success
 *   { statusCode: -1, message, ... }        -> failure (see plugins/error-handler.ts)
 *
 * Two halves live in this file and they must stay in sync:
 *   - the `*Envelope` builders produce the Zod schema a route declares in
 *     `response`, which Fastify compiles into a fast-json-stringify serializer;
 *   - `ok`/`paginated` produce the object a handler returns.
 *
 * The serializer only emits fields the schema declares, so a field that leaks
 * into a handler's return value (a password hash, an internal flag) is dropped
 * on the way out rather than shipped to the client.
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
    // Pagination lives beside the list, never inside it, so a client can render
    // `data` without unwrapping anything.
    meta: z.object({
      page: z.number().int(),
      limit: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });

/**
 * Declared on routes purely so the OpenAPI docs describe failures too.
 *
 * `details` is a concrete array rather than z.unknown() on purpose: the
 * response serializer needs a real schema to compile, and an error payload
 * whose shape varies is exactly the thing a client cannot code against.
 */
export const errorDetailSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorEnvelope = z.object({
  statusCode: z.literal(-1),
  message: z.string(),
  requestId: z.string().optional(),
  details: z.array(errorDetailSchema).optional(),
  /**
   * Attached by the error handler outside production only. It has to be
   * declared here even though it is a debugging aid: the response serializer
   * emits nothing the schema does not mention, so an undeclared `stack` was
   * silently dropped on every route with a declared error response — i.e. on
   * exactly the routes where you would go looking for it.
   */
  stack: z.string().optional(),
});

export const ok = <T>(data: T, message = "Success") => ({
  statusCode: 0 as const,
  message,
  data,
});

export const paginated = <T>(
  data: T[],
  { page, limit, total }: { page: number; limit: number; total: number },
  message = "Success"
) => ({
  statusCode: 0 as const,
  message,
  data,
  meta: {
    page,
    limit,
    total,
    totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
  },
});
