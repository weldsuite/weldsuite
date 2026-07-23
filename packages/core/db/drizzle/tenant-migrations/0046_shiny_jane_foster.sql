CREATE TABLE "task_digest_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"send_hour" integer DEFAULT 8 NOT NULL,
	"task_types" jsonb DEFAULT '{"projectTasks":true,"personalTasks":true}'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '{"overdue":true,"dueToday":true,"dueThisWeek":true}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
