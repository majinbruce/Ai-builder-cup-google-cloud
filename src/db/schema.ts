import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * ============================================================================
 * The single definition of this database's shape.
 * ============================================================================
 *
 * Three things read this file, and that is the whole reason it exists:
 *
 *   1. drizzle-kit, to GENERATE the SQL in db/migrations. Migrations are no
 *      longer hand-written — `npm run db:generate` diffs this file against the
 *      migrations already on disk and emits the difference.
 *   2. The query builder, so `db.select().from(users)` knows the columns and
 *      their types. `UserRow` below is inferred, never transcribed.
 *   3. Better Auth, through the Drizzle adapter in auth.factory.ts.
 *
 * That third consumer is what killed the mapping this codebase used to carry.
 * With the Kysely adapter, every Better Auth field had to be told its column
 * name (`emailVerified` -> `email_verified`) in auth.factory.ts, and the SQL
 * migration was the other, unverified half of that mapping. Now the property
 * name IS the Better Auth field and the string beside it IS the column, in one
 * place the compiler checks. Drift between the two is no longer expressible.
 *
 * Naming: JavaScript sees camelCase, Postgres sees snake_case. Deliberate on
 * both sides — one is idiomatic in each language, and nothing in between has
 * to know.
 */

/**
 * The person. One row per human, regardless of how many ways they can sign in.
 */
export const users = pgTable(
  "users",
  {
    /**
     * `advanced.database.generateId: "uuid"` means Better Auth generates the
     * value in JavaScript, so defaultRandom() is not what normally fills this
     * column — it is the safety net for a hand-written INSERT or a seed script.
     * Postgres 13+ has gen_random_uuid() in core; no pgcrypto extension.
     */
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * Better Auth lowercases the address before it ever reaches SQL, so a plain
     * UNIQUE is enough here — no LOWER() expression index needed. The 23505
     * this raises is what the error handler turns into a 409.
     */
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    /**
     * The app-level role. `{ enum: [...] }` gives TypeScript the union without
     * creating a Postgres enum type — a CREATE TYPE would make adding a role
     * later a migration with a lock, where a TEXT + CHECK is a one-line ALTER.
     *
     * The CHECK below is not redundant with the union: TypeScript's guarantee
     * stops at the driver, and this column is also written by psql, by seeds
     * and by whatever else reaches the database.
     */
    role: text("role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Matches the users list query's ORDER BY created_at DESC.
    index("users_created_at_idx").on(table.createdAt.desc()),
    check("users_role_check", sql`${table.role} IN ('user', 'admin')`),
  ]
);

/**
 * One row per active login. `token` is the opaque value carried by the session
 * cookie (and, for non-browser clients, by the bearer header) — it is looked up
 * on every authenticated request, which is exactly what makes a session
 * revocable: DELETE the row and the next request is a 401.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The cascade is load-bearing, not tidiness: deleting a user has to revoke
     * their sessions, or a "deleted" account keeps authenticating until its
     * token expires. See the note on the hard delete in user.repository.ts.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)]
);

/**
 * One row per *way of signing in*. This is the table that makes account linking
 * work: a user who signed up with a password and later used "Continue with
 * Google" has one users row and two accounts rows.
 *
 * The password hash lives HERE, on the providerId = 'credential' row, not on
 * the user — to Better Auth a password is just another linked credential.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // issuer + accountId is the stable provider-side identity; providerId is
    // which of our configured providers produced it.
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    // scrypt hash for providerId = 'credential'; NULL for OAuth accounts.
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    // The uniqueness that stops one provider identity being attached to two users.
    uniqueIndex("accounts_issuer_account_id_uidx").on(table.issuer, table.accountId),
  ]
);

/**
 * Short-lived single-use tokens: email verification, password reset, and the
 * OAuth state + PKCE verifier for an in-flight Google sign-in. Rows are
 * consumed on use and expire on their own.
 */
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)]
);

/**
 * The whole schema as one object. plugins/db.ts hands this to drizzle() so that
 * `db.query.users.findFirst(...)` exists, and auth.factory.ts hands the same
 * tables to the Better Auth adapter — one source, two consumers.
 */
export const schema = { users, sessions, accounts, verifications };

/**
 * Row types, INFERRED. The hand-written `type UserRow = {...}` this replaces
 * could disagree with the database; this cannot. `$inferSelect` is what a
 * SELECT returns, `$inferInsert` is what an INSERT accepts (defaults optional).
 */
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
