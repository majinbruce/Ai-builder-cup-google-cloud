import "server-only";
import { headers } from "next/headers";
import type { z } from "zod";
import { env } from "@/lib/env";
import { ApiError, parseResponse } from "@/lib/api/envelope";
import type { ApiRequestOptions } from "@/lib/api/client";

/**
 * The server components' API caller.
 *
 * Two things make it different from the browser's, and both are the reason it
 * is a separate file rather than a branch inside one:
 *
 *   1. ABSOLUTE URL. There is no origin to be relative to inside a server
 *      render, and in production the API is reached by its Docker network name
 *      (`http://api:3000`) — which never leaves the box and skips the proxy.
 *
 *   2. COOKIES ARE NOT AUTOMATIC. A server render has no browser attached to
 *      it, so the incoming request's Cookie header has to be forwarded by hand.
 *      Forgetting this is the classic "works in the browser, 401 on the server"
 *      bug, and it is why every server call goes through this function.
 *
 * Nothing here is cached: `headers()` makes the render dynamic anyway, and a
 * cached response keyed without the cookie would serve one user's data to
 * another. If you want caching, cache the *rendered* output, not this.
 */
export async function apiFetchServer<T extends z.ZodType>(
  path: string,
  schema: T,
  options: ApiRequestOptions = {}
): Promise<z.infer<T>> {
  const { method = "GET", body, query, signal } = options;

  const url = new URL(path, env.API_ORIGIN);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const incoming = await headers();
  const cookie = incoming.get("cookie");

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(cookie === null ? {} : { cookie }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("The API is unreachable", { status: 0 });
  }

  return parseResponse(response, schema);
}
