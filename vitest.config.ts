import { defineConfig } from "vitest/config";

/**
 * Two projects, because the suite has two kinds of test and only one of them
 * needs a database.
 *
 *   unit         test/*.test.ts           app.inject(), no Postgres, no setup
 *   integration  test/integration/**      real Postgres, migrated once per run
 *
 * The split is not cosmetic. The pg pool connects lazily, so everything that
 * fails before touching the database — validation, the auth guards, 404s, the
 * error envelope — is genuinely testable on a fresh clone with nothing running.
 * A single shared `globalSetup` threw that away: it ran before every file and
 * failed the whole command, so `npm test` without `docker compose up` produced
 * zero passing tests and one confusing error about a database the unit tests
 * never wanted.
 *
 *   npm test              both (needs Postgres)
 *   npm run test:unit     no database required
 *   npm run test:integration
 */

// NODE_ENV must be set before any test file is imported, so that src/config
// picks up .env.test rather than .env.development. Declared per project because
// a project does not inherit the root `test` block.
const env = { NODE_ENV: "test" };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          env,
          include: ["test/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          env,
          include: ["test/integration/**/*.test.ts"],
          /**
           * Migrates and truncates the app_test database once per run. Test
           * files still execute in parallel — isolation comes from every test
           * minting a unique email, not from serialising the suite.
           */
          globalSetup: ["test/globalSetup.ts"],
        },
      },
    ],
  },
});
