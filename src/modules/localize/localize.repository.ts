import { and, count, desc, eq, gte, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
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
  outputVideoUri?: string;
  /** The FULL call list so far — replaced, not appended, so a write is idempotent. */
  calls?: ModelCall[];
}

export const insert = async (
  db: Database,
  values: {
    id: string;
    userId: string;
    targetLanguage: string;
    sourceUri: string;
    sourceVideoUri?: string;
    posterUri?: string;
    sourceDurationSec?: number;
  }
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
  if (first !== undefined) {
    return { rows: rows.map((entry) => entry.job), total: Number(first.totalCount) };
  }

  // The window count rides on the returned rows, so a page past the end has
  // none to carry it — and would report total 0 for a user who has jobs.
  if (offset === 0) return { rows: [], total: 0 };

  const [row] = await db
    .select({ total: count() })
    .from(localizeJobs)
    .where(eq(localizeJobs.userId, userId));

  return { rows: [], total: row?.total ?? 0 };
};

/**
 * Writes whatever a stage produced, plus the next status, in one UPDATE.
 *
 * Never onto a failed row. A job can be marked failed from outside its own run —
 * by shutdown, or by the reaper — while the run is still going; without this
 * guard its next stage write would quietly move it back to "adapting", and the
 * UI would poll a job that no process is running.
 */
export const updateStage = async (
  db: Database,
  id: string,
  write: StageWrite
): Promise<void> => {
  await db
    .update(localizeJobs)
    .set({ ...write, updatedAt: new Date() })
    .where(and(eq(localizeJobs.id, id), ne(localizeJobs.status, "failed")));
};

/**
 * Deletes one job, but only if it belongs to `userId` — the same WHERE-clause
 * ownership as findForUser. Returns whether a row went.
 */
export const deleteForUser = async (
  db: Database,
  id: string,
  userId: string
): Promise<boolean> => {
  const deleted = await db
    .delete(localizeJobs)
    .where(and(eq(localizeJobs.id, id), eq(localizeJobs.userId, userId)))
    .returning({ id: localizeJobs.id });
  return deleted.length > 0;
};

/** How many jobs a user has started since `since`, whatever became of them. */
export const countCreatedSince = async (
  db: Database,
  userId: string,
  since: Date
): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(localizeJobs)
    .where(and(eq(localizeJobs.userId, userId), gte(localizeJobs.createdAt, since)));

  return row?.total ?? 0;
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

const RESTARTED_ERROR =
  "The server restarted while this job was running, and jobs run in-process. " +
  "Upload the clip again.";

/**
 * Fails every in-flight job not touched since `before`, except `running`.
 *
 * Keyed on `updated_at`, not `created_at`: every stage bumps it, so a job that
 * is slow but alive keeps refreshing its own timestamp, and only one whose
 * process is gone stops. `running` is this process's own live jobs, which are
 * alive by definition however slow a stage is. Returns the ids so the log can
 * name them.
 */
export const failStale = async (
  db: Database,
  before: Date,
  running: readonly string[] = []
): Promise<string[]> => {
  const rows = await db
    .update(localizeJobs)
    .set({ status: "failed", error: RESTARTED_ERROR, updatedAt: new Date() })
    .where(
      and(
        inArray(localizeJobs.status, IN_FLIGHT),
        lt(localizeJobs.updatedAt, before),
        running.length > 0 ? notInArray(localizeJobs.id, [...running]) : undefined
      )
    )
    .returning({ id: localizeJobs.id });

  return rows.map((row) => row.id);
};

/** Fails the given jobs if still in flight. For shutdown, which is about to kill them. */
export const failInFlight = async (
  db: Database,
  ids: readonly string[]
): Promise<string[]> => {
  if (ids.length === 0) return [];

  const rows = await db
    .update(localizeJobs)
    .set({ status: "failed", error: RESTARTED_ERROR, updatedAt: new Date() })
    .where(
      and(inArray(localizeJobs.id, [...ids]), inArray(localizeJobs.status, IN_FLIGHT))
    )
    .returning({ id: localizeJobs.id });

  return rows.map((row) => row.id);
};

/**
 * Makes `id` THE demo, if it is done: flags it and unflags every other job, in
 * one transaction.
 *
 * Unflagging is the point. findDemo serves the newest flagged row by
 * updated_at, and promotion does not make a job newer — so without it, promoting
 * a job that finished before the current demo would report success and change
 * nothing on the public page.
 */
export const setDemo = async (db: Database, id: string): Promise<boolean> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .update(localizeJobs)
      .set({ isDemo: true })
      .where(and(eq(localizeJobs.id, id), eq(localizeJobs.status, "done")))
      .returning({ id: localizeJobs.id });

    if (rows.length === 0) return false;

    await tx
      .update(localizeJobs)
      .set({ isDemo: false })
      .where(and(eq(localizeJobs.isDemo, true), ne(localizeJobs.id, id)));

    return true;
  });

const nullable = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null =>
  value === null ? null : schema.parse(value);

export const toDto = (row: LocalizeJobRow): Job => ({
  id: row.id,
  status: row.status,
  targetLanguage: row.targetLanguage,
  sourceUri: row.sourceUri,
  sourceVideoUri: row.sourceVideoUri,
  outputVideoUri: row.outputVideoUri,
  posterUri: row.posterUri,
  sourceDurationSec: row.sourceDurationSec,
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

/**
 * Just the two fields the list shows, read leniently.
 *
 * Deliberately not the full Analysis parse toDto does: the list is how a user
 * reaches every job, so one row an older build wrote must not turn it into a
 * 500. That row still fails loudly when opened, where the field gets named.
 */
const SummaryFields = z.object({
  topic: z.string(),
  segments: z.array(z.unknown()),
});

export const toSummary = (row: LocalizeJobRow): JobSummary => {
  const parsed = SummaryFields.safeParse(row.analysis);
  const analysis = parsed.success ? parsed.data : null;

  return {
    id: row.id,
    status: row.status,
    topic: analysis?.topic ?? null,
    segmentCount: analysis?.segments.length ?? null,
    hasVideo: row.sourceVideoUri !== null,
    hasPoster: row.posterUri !== null,
    durationSec: row.sourceDurationSec,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};
