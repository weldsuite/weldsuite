CREATE TABLE "task_number_sequences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"scope" varchar(30) DEFAULT 'task' NOT NULL,
	"prefix" varchar(20) DEFAULT 'TASK-' NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
-- Backfill existing tasks with a workspace-wide number ordered by creation date
-- (oldest = 1). Soft-deleted rows are numbered too, keeping uniqueness simple.
WITH numbered AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "tasks"
)
UPDATE "tasks" SET "number" = numbered.rn
FROM numbered WHERE "tasks"."id" = numbered."id";--> statement-breakpoint
-- Seed the counter so the next allocation continues past the highest backfilled
-- number. First allocation hands out MAX(number) + 1.
INSERT INTO "task_number_sequences" ("id", "scope", "prefix", "next_value")
VALUES ('seq_tasknum_default', 'task', 'TASK-', COALESCE((SELECT MAX("number") FROM "tasks"), 0) + 1);--> statement-breakpoint
CREATE UNIQUE INDEX "task_number_sequences_scope_unique" ON "task_number_sequences" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_number_unique" ON "tasks" USING btree ("number");