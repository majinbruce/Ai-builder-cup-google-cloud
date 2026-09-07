import { z } from "zod";
import { paginatedEnvelope, successEnvelope } from "@/lib/api/envelope";
import { apiFetch } from "@/lib/api/client";
import { userSchema, type User } from "@/lib/api/schemas";

/**
 * ============================================================================
 * A resource module — the pattern every API surface in this app follows.
 * ============================================================================
 *
 * One file per resource, mirroring one module in the API. It owns:
 *
 *   - the response schema for each endpoint (composed from `schemas.ts`)
 *   - one exported function per endpoint, named after the API's own summary
 *   - nothing else: no React, no state, no toast, no router
 *
 * Components import these functions; they never call `apiFetch` with a raw
 * path. That keeps the URL, the method and the response shape of an endpoint
 * in ONE place, so changing it is one edit rather than a grep.
 *
 * These are the BROWSER-side callers. A server component that needs the same
 * data calls `apiFetchServer` with the same schema — see `usersListResponse`
 * below being reused in `src/app/(app)/admin/users/page.tsx`.
 */
export const userResponse = successEnvelope(userSchema);
export const usersListResponse = paginatedEnvelope(userSchema);

export type UsersListResponse = z.infer<typeof usersListResponse>;

export interface ListUsersParams {
  page?: number;
  limit?: number;
  search?: string;
}

/** GET /api/v1/users — admin only; the rows carry email addresses. */
export async function listUsers(
  params: ListUsersParams = {}
): Promise<UsersListResponse> {
  return apiFetch("/api/v1/users", usersListResponse, { query: { ...params } });
}

/** GET /api/v1/users/:id — self or admin. */
export async function getUser(id: string): Promise<User> {
  const body = await apiFetch(`/api/v1/users/${id}`, userResponse);
  return body.data;
}

/**
 * PATCH /api/v1/users/me — the self-service profile update.
 *
 * Note what this cannot send: `role`. The API's self-service body schema is a
 * `z.strictObject` without it, so an extra key is a 400 rather than a silent
 * strip — and this signature is the frontend saying the same thing. Role
 * changes go through `updateUser` below, which the API guards with an admin
 * check.
 */
export async function updateOwnProfile(input: { name: string }): Promise<User> {
  const body = await apiFetch("/api/v1/users/me", userResponse, {
    method: "PATCH",
    body: input,
  });
  return body.data;
}

/** PATCH /api/v1/users/:id — admin only; the only path that may set `role`. */
export async function updateUser(
  id: string,
  input: { name?: string; role?: User["role"] }
): Promise<User> {
  const body = await apiFetch(`/api/v1/users/${id}`, userResponse, {
    method: "PATCH",
    body: input,
  });
  return body.data;
}

/** DELETE /api/v1/users/:id — admin only; cascades the user's sessions. */
export async function deleteUser(id: string): Promise<void> {
  await apiFetch(`/api/v1/users/${id}`, successEnvelope(z.null()), {
    method: "DELETE",
  });
}
