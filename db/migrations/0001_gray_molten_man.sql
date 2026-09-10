CREATE TABLE "localize_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_language" text NOT NULL,
	"source_uri" text,
	"error" text,
	"analysis" jsonb,
	"corroboration" jsonb,
	"adaptation" jsonb,
	"critique" jsonb,
	"retried_ids" jsonb,
	"synthesis" jsonb,
	"calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "localize_jobs_status_check" CHECK ("localize_jobs"."status" IN ('queued', 'ingesting', 'analyzing', 'adapting', 'critiquing', 'synthesizing', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "localize_jobs" ADD CONSTRAINT "localize_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "localize_jobs_user_created_idx" ON "localize_jobs" USING btree ("user_id","created_at" DESC NULLS LAST);