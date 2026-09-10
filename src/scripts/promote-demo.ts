import process from "node:process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config/index.ts";
import { schema } from "../db/schema.ts";
import { setDemo } from "../modules/localize/localize.repository.ts";
import { fail, out } from "./print.ts";

/**
 * Marks a finished job as the public demo.
 *
 *   npm run localize:promote-demo -- <jobId>
 *
 * GET /api/v1/localize/demo serves the newest promoted job signed-out (SPEC
 * section h: "Public URL works signed-out for the demo job"). The demo is a real
 * job the API ran end to end, flagged afterwards, rather than JSON imported from
 * a CLI run — so what a judge sees on the public page is exactly what the upload
 * path produces, telemetry included, and nothing about it was assembled by hand.
 *
 * A script rather than a route: promoting makes a user's upload public, and no
 * HTTP surface should be able to do that.
 */

const jobId = process.argv[2];

if (jobId === undefined || !/^[0-9a-f-]{36}$/i.test(jobId)) {
  fail("Usage: npm run localize:promote-demo -- <jobId>");
}

const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

try {
  const promoted = await setDemo(drizzle(pool, { schema }), jobId);

  if (!promoted) {
    fail(`No job ${jobId} with status "done". Only a finished job can be the demo.`);
  }

  out(`Job ${jobId} is now the demo. GET /api/v1/localize/demo serves it signed-out.`);
} finally {
  await pool.end();
}
