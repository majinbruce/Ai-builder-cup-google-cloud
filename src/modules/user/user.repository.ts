import { desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Database } from "../../plugins/db.ts";
import { users, type UserRow } from "../../db/schema.ts";
import type { UserDto } from "./user.schemas.ts";

/**
 * Every query here is built by Drizzle against src/db/schema.ts, so the row
 * type is inferred rather than declared: rename a column in the schema and this
 * file stops compiling, instead of returning `undefined` at runtime.
 *
 * The table these read is owned by Better Auth — it writes to it during sign-up
 * through the same schema object (see auth.factory.ts). Reading it here is fine
 * and is the point of sharing one definition; what this module must NOT do is
 * write anything Better Auth has invariants about (email, and the password that
 * lives over on `accounts`).
 *
 * Drizzle parameterises everything it builds, including the `ilike` patterns
 * below. There is no string interpolation of user input anywhere in this file,
 * and `sql` is only ever used for fixed fragments.
 */

// Re-exported so callers keep importing the row type from the repository.
export type { UserRow };

export const findById = async (db: Database, id: string): Promise<UserRow | null> => {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return row ?? null;
};

/**
 * `%` and `_` are wildcards inside a LIKE pattern even when the pattern itself
 * is a bind parameter — parameterisation stops injection, not pattern
 * metacharacters. Unescaped, a search for "%" matches every row and a search
 * for "100%_guaranteed" matches things it should not; escaped, the characters
 * mean themselves. Backslash is Postgres' default LIKE escape character, and it
 * must be escaped first so it cannot un-escape the other two.
 */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

/**
 * COUNT(*) OVER() returns the total alongside the page in one round trip,
 * instead of a second COUNT query that can disagree with the first. Drizzle has
 * no builder for a window function, so it is a raw fragment — a fixed one, with
 * the pagination and the search still parameterised.
 */
export const list = async (
  db: Database,
  { limit, offset, search }: { limit: number; offset: number; search?: string }
): Promise<{ rows: UserRow[]; total: number }> => {
  const pattern = search === undefined ? undefined : `%${escapeLikePattern(search)}%`;

  const where =
    pattern === undefined
      ? undefined
      : or(ilike(users.name, pattern), ilike(users.email, pattern));

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      image: users.image,
      role: users.role,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      totalCount: sql<string>`COUNT(*) OVER()`,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const first = rows[0];
  const total = first ? Number(first.totalCount) : 0;

  return { rows, total };
};

/**
 * A partial update, without the COALESCE trick the hand-written SQL needed:
 * Drizzle's `set` only emits the columns present in the object, so an absent
 * field is genuinely absent from the UPDATE rather than being passed as null
 * and coalesced back to its own value.
 *
 * The empty-patch case still has to be handled, because `SET updated_at = NOW()`
 * alone is a valid statement and the route should not treat "nothing to change"
 * as a 404.
 */
export const update = async (
  db: Database,
  id: string,
  { name, role }: { name?: string; role?: "user" | "admin" }
): Promise<UserRow | null> => {
  const [row] = await db
    .update(users)
    .set({
      ...(name === undefined ? {} : { name }),
      ...(role === undefined ? {} : { role }),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();

  return row ?? null;
};

/**
 * A hard delete, where this used to be a soft one.
 *
 * Soft delete and Better Auth do not mix: its session lookup does not know
 * about a deleted_at column, so a "deleted" user would keep authenticating
 * with an existing session and could still sign in. The ON DELETE CASCADE on
 * sessions and accounts means removing the row also revokes every session and
 * unlinks every provider, which is the behaviour deleting an account should
 * have had anyway.
 */
export const remove = async (db: Database, id: string): Promise<string | null> => {
  const [row] = await db
    .delete(users)
    .where(eq(users.id, id))
    .returning({ id: users.id });

  return row?.id ?? null;
};

/**
 * The boundary between "database row" and "API resource". Keeping them apart
 * means a column rename is a one-line change here instead of a breaking API
 * change — and it is still worth having with Drizzle, because the inferred row
 * type would otherwise leak straight into the response schema.
 */
export const toDto = (row: UserRow): UserDto => ({
  id: row.id,
  name: row.name,
  email: row.email,
  emailVerified: row.emailVerified,
  image: row.image,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
