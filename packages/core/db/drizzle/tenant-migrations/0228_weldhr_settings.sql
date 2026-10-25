CREATE TABLE "hr_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_self_clock_in" boolean DEFAULT true NOT NULL,
	"employee_leave_requests" boolean DEFAULT true NOT NULL,
	"employee_declarations" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Carry the My HR self-service switches over from the workforce portal settings (dropped in the next migration).
INSERT INTO "hr_settings" ("id", "employee_self_clock_in", "employee_leave_requests", "employee_declarations", "created_at", "updated_at")
SELECT "id", "employee_self_clock_in", "employee_leave_requests", "employee_declarations", "created_at", "updated_at"
FROM "hr_portal_settings"
ORDER BY "created_at"
LIMIT 1;