import type { z } from "zod";
import { ApiError, parseResponse } from "@/lib/api/envelope";

/**
 * The browser's API caller.
 *
 * Note the URL: RELATIVE, always. `/api/v1/users` is same-origin, which is what
 * makes the session cookie first-party and CORS irrelevant. See the long note
 * in next.config.ts for who forwards it to Fastify in each environment.
 *
 * This file has no `server-only` guard and no `use client` directive on
 * purpose — it is a plain module, usable from any client component.
 */
export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Serialised as JSON. Use `undefined`, not `null`, for "no body". */
  body?: unknown;
  /** Appended as a query string; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildPath(path: string, query: ApiRequestOptions["query"]): string {
  if (!query) return path;

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export async function apiFetch<T extends z.ZodType>(
  path: string,
  schema: T,
  options: ApiRequestOptions = {}
): Promise<z.infer<T>> {
  const { method = "GET", body, query, signal } = options;

  let response: Response;

  try {
    response = await fetch(buildPath(path, query), {
      method,
      // Same-origin, so cookies ride along by default — but being explicit
      // means this keeps working if someone later points it at another origin.
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    // Offline, DNS failure, an aborted navigation. There is no status and no
    // envelope; 0 is the conventional stand-in and keeps callers on one type.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;

    throw new ApiError("Could not reach the server. Check your connection.", {
      status: 0,
    });
  }

  return parseResponse(response, schema);
}
