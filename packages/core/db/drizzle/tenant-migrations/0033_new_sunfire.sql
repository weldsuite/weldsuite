CREATE TABLE "sequence_enrollments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"sequence_id" varchar(30) NOT NULL,
	"customer_id" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"execution_id" varchar(30),
	"current_step_index" integer DEFAULT 0,
	"total_steps" integer DEFAULT 0,
	"enrolled_by" varchar(255),
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"paused_at" timestamp,
	"unenrolled_at" timestamp,
	"failed_at" timestamp,
	"error_message" varchar(1000),
	"customer_snapshot" jsonb,
	CONSTRAINT "sequence_enrollments_unique_idx" UNIQUE("sequence_id","customer_id")
);
--> statement-breakpoint
CREATE INDEX "sequence_enrollments_sequence_id_idx" ON "sequence_enrollments" USING btree ("sequence_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_customer_id_idx" ON "sequence_enrollments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_status_idx" ON "sequence_enrollments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_execution_id_idx" ON "sequence_enrollments" USING btree ("execution_id");