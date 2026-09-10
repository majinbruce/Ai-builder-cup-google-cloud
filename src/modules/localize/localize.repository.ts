import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../../plugins/db.ts";
import { localizeJobs, type LocalizeJobRow } from "../../db/schema.ts";
import {
  Adaptation,
  Analysis,
  Corroboration,
  Critique,
  ModelCall,
  Synthesis,
} from "./localize.schemas.ts";
import type { Job, JobStatus, JobSummary } from "./localize.schemas.ts";
import { z } from "zod";

/**
 * Drizzle queries for `localize_jobs`, and the row-to-DTO boundary.
 *
 * The jsonb columns come back typed `unknown`, which is correct: Postgres does
 * not know their shape and neither does Drizzle. toDto() parses each one with
 * the same Zod schema that validated it when the stage produced it, so a row
 * written by an older build and read by a newer one fails HERE, with the field
 * named, rather than as a response-serialization 500 or an `undefined` in the
 * reasoning panel.
 */

export type { LocalizeJobRow };

/** Artifacts a stage can write. Keys are the table's camelCase columns. */
export interface StageWrite {
  status?: JobStatus;
  analysis?: Analysis;
  corroboration?: Corroboration;
  adaptation?: Adaptation;
  critique?: Critique;
  retriedIds?: string[];
  synthesis?: Synthesis;
  /** The FULL call list so far — replaced, not appended, so a write is idempotent. */
  calls?: ModelCall[];
}

export const insert = async (
  db: Database,
  values: { id: string; userId: string; targetLanguage: string; sourceUri: string }
): Promise<LocalizeJobRow> => {
  const [row] = await db
    .insert(localizeJobs)
    .values({ ...values, status: "queued" })
    .returning();

  if (row === undefined) throw new Error("INSERT ... RETURNING returned no row");
  return row;
};

/**
 * One job, but only if it belongs to `userId`.
 *
 * The ownership rule is in the WHERE clause rather than checked afterwards, so
 * there is no code path that loads somebody else's row and then decides not to
 * show it. The caller cannot tell "not yours" from "does not exist", which is
 * the point: a 403 would confirm to a guesser that the id is real.
 */
export const findForUser = async (
  db: Database,
  id: string,
  userId: string
): Promise<LocalizeJobRow | null> => {
  const [row] = await db
    .select()
    .from(localizeJobs)
    .where(and(eq(localizeJobs.id, id), eq(localizeJobs.userId, userId)))
    .limit(1);

  return row ?? null;
};

/** Unscoped read, for the job runner only — it is not acting for a user. */
export const findById = async (
  db: Database,
  id: string
): Promise<LocalizeJobRow | null> => {
  const [row] = await db
    .select()
    .from(localizeJobs)
    .where(eq(localizeJobs.id, id))
    .limit(1);

  return row ?? null;
};

/** The newest demo job, if one has been promoted. */
export const findDemo = async (db: Database): Promise<LocalizeJobRow | null> => {
  const [row] = await db
    .select()
    .from(localizeJobs)
    .where(and(eq(localizeJobs.isDemo, true), eq(localizeJobs.status, "done")))
    .orderBy(desc(localizeJobs.updatedAt))
    .limit(1);

  return row ?? null;
};

/**
 * One user's jobs, newest first, with the total in the same query.
 *
 * Selects the whole row, jsonb included, because JobSummary needs the topic and
 * the segment count, which live inside `analysis`. At twenty rows of ~50 KB
 * that is fine; it would be the first thing to change if a list ever paged
 * through hundreds.
 */
export const listForUser = async (
  db: Database,
  userId: string,
  { limit, offset }: { limit: number; offset: number }
): Promise<{ rows: LocalizeJobRow[]; total: number }> => {
  const rows = await db
    .select({ job: localizeJobs, totalCount: sql<string>`COUNT(*) OVER()` })
    .from(localizeJobs)
    .where(eq(localizeJobs.userId, userId))
    .orderBy(desc(localizeJobs.createdAt))
    .limit(limit)
    .offset(offset);

  const first = rows[0];

  return {
    rows: rows.map((entry) => entry.job),
    total: first ? Number(first.totalCount) : 0,
  };
};

/** Writes whatever a stage produced, plus the next status, in one UPDATE. */
export const updateStage = async (
  db: Database,
  id: string,
  write: StageWrite
): Promise<void> => {
  await db
    .update(localizeJobs)
    .set({ ...write, updatedAt: new Date() })
    .where(eq(localizeJobs.id, id));
};

export const markFailed = async (
  db: Database,
  id: string,
  error: string
): Promise<void> => {
  await db
    .update(localizeJobs)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(eq(localizeJobs.id, id));
};

/** The statuses a job can be abandoned in by a process that died mid-run. */
const IN_FLIGHT: JobStatus[] = [
  "queued",
  "ingesting",
  "analyzing",
  "adapting",
  "critiquing",
  "synthesizing",
];

/**
 * Fails every in-flight job not touched since `before`.
 *
 * Keyed on `updated_at`, not `created_at`: every stage bumps it, so a job that
 * is slow but alive keeps refreshing its own timestamp, and only one whose
 * process is gone stops. Returns the ids so the boot log can name them.
 */
export const failStale = async (db: Database, before: Date): Promise<string[]> => {
  const rows = await db
    .update(localizeJobs)
    .set({
      status: "failed",
      error:
        "The server restarted while this job was running, and jobs run in-process. " +
        "Upload the clip again.",
      updatedAt: new Date(),
    })
    .where(
      and(inArray(localizeJobs.status, IN_FLIGHT), lt(localizeJobs.updatedAt, before))
    )
    .returning({ id: localizeJobs.id });

  return rows.map((row) => row.id);
};

export const setDemo = async (db: Database, id: string): Promise<boolean> => {
  const rows = await db
    .update(localizeJobs)
    .set({ isDemo: true })
    .where(and(eq(localizeJobs.id, id), eq(localizeJobs.status, "done")))
    .returning({ id: localizeJobs.id });

  return rows.length > 0;
};

const nullable = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null =>
  value === null ? null : schema.parse(value);

export const toDto = (row: LocalizeJobRow): Job => ({
  id: row.id,
  status: row.status,
  targetLanguage: row.targetLanguage,
  sourceUri: row.sourceUri,
  error: row.error,
  analysis: nullable(Analysis, row.analysis),
  corroboration: nullable(Corroboration, row.corroboration),
  adaptation: nullable(Adaptation, row.adaptation),
  critique: nullable(Critique, row.critique),
  retriedIds: nullable(z.array(z.string()), row.retriedIds),
  synthesis: nullable(Synthesis, row.synthesis),
  calls: z.array(ModelCall).parse(row.calls),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toSummary = (row: LocalizeJobRow): JobSummary => {
  const analysis = nullable(Analysis, row.analysis);

  return {
    id: row.id,
    status: row.status,
    topic: analysis?.topic ?? null,
    segmentCount: analysis?.segments.length ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};
