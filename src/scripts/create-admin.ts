import process from "node:process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { config } from "../config/index.ts";
import { schema, users } from "../db/schema.ts";
import { createAuth } from "../modules/auth/auth.factory.ts";
import type { Mailer } from "../lib/mailer.ts";

/**
 * ============================================================================
 * Creates or promotes the first administrator.
 * ============================================================================
 *
 * Why this script has to exist:
 *
 * `role` is declared `input: false` in auth.factory.ts, so no request body can
 * ever set it — that is the control that stops "authenticated user promotes
 * themselves to admin". The only writer is `PATCH /api/v1/users/:id`, which is
 * itself guarded by `requireRole("admin")`.
 *
 * Which means a freshly migrated database has no admin and no way to get one:
 * every admin-only route is unreachable forever. The bootstrap has to come from
 * outside the HTTP surface, and this is it — a deliberate, auditable, local
 * action rather than a hole in the permission model.
 *
 *   npm run create-admin -- you@example.com
 *       Promotes an existing account. Use this once you have signed up through
 *       the app normally. Does not touch their password.
 *
 *   npm run create-admin -- you@example.com --create
 *       Creates the account too, prompting for nothing: reads the password from
 *       the ADMIN_PASSWORD environment variable. The account is marked
 *       email-verified, because on a fresh deploy the mailer may not be wired
 *       up yet and an admin who cannot sign in is not an admin.
 *
 * The password goes through the environment rather than argv because argv is
 * visible in `ps` output and in shell history.
 */

const usage = `
Usage:
  npm run create-admin -- <email>            promote an existing account
  npm run create-admin -- <email> --create   create the account first
                                             (password from ADMIN_PASSWORD)
`.trim();

const out = (message: string) => process.stdout.write(`${message}\n`);

// A declaration rather than a `const` arrow, deliberately: TypeScript only
// applies never-returning narrowing to a function declaration or an explicitly
// annotated identifier, and every check below relies on the code after a
// `fail(...)` being unreachable.
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const email = args
  .find((arg) => !arg.startsWith("--"))
  ?.trim()
  .toLowerCase();
const shouldCreate = args.includes("--create");

if (email === undefined || email === "") fail(usage);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Not an email address: ${email}`);

const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

const db = drizzle(pool, { schema });

/**
 * Better Auth owns password hashing, so creating an account means going through
 * its own sign-up endpoint rather than writing an `accounts` row by hand — a
 * hand-written row would have to reproduce its scrypt parameters exactly, and
 * would silently stop matching after any upgrade.
 *
 * The mailer is a no-op: this path marks the account verified itself, so there
 * is no verification link worth delivering, and a script should not depend on
 * SMTP being configured.
 */
const silentMailer: Mailer = { send: async () => Promise.resolve() };

const findByEmail = async () => {
  const [row] = await db
    .select({ id: users.id, role: users.role, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  return row ?? null;
};

try {
  let existing = await findByEmail();

  if (existing === null && !shouldCreate) {
    fail(
      `No account found for ${email}.\n\n` +
        "Sign up through the app first, then re-run this to promote it — or " +
        "pass --create with ADMIN_PASSWORD set to create the account here.\n\n" +
        usage
    );
  }

  if (existing === null) {
    const password = process.env["ADMIN_PASSWORD"];

    if (password === undefined || password === "") {
      fail("--create requires ADMIN_PASSWORD to be set in the environment.");
    }

    const auth = createAuth({
      db,
      mailer: silentMailer,
      // The script's own stdout, shaped like the logger the factory expects.
      log: {
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        error: (...parts: unknown[]) => process.stderr.write(`${String(parts[1])}\n`),
      },
    });

    // signUpEmail applies the same password policy, hashing and validation a
    // real registration does. If ADMIN_PASSWORD is weak, this is where it fails.
    await auth.api.signUpEmail({
      body: { email, password, name: "Administrator" },
    });

    existing = await findByEmail();

    if (existing === null) fail(`Sign-up reported success but ${email} is not in users.`);

    out(`Created ${email}.`);
  }

  if (existing.role === "admin" && existing.emailVerified) {
    out(`${email} is already a verified admin. Nothing to do.`);
  } else {
    // emailVerified is forced alongside the role: an admin created by this
    // script has been vouched for by whoever has database credentials, which is
    // a stronger signal than clicking a link in an inbox.
    await db
      .update(users)
      .set({ role: "admin", emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, existing.id));

    out(`${email} is now an admin.`);
  }

  out(
    "\nThis grants access to every admin-only route, including the user list " +
      "(which carries every user's email) and user deletion."
  );
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
} finally {
  await pool.end();
}
