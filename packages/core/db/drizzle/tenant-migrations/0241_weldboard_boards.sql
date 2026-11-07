CREATE TABLE "board_versions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"board_id" varchar(255) NOT NULL,
	"revision" integer NOT NULL,
	"name" varchar(255),
	"snapshot_key" varchar(1000) NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "whiteboards" ALTER COLUMN "scene" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "snapshot_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "snapshot_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "template_category" varchar(32);--> statement-breakpoint
ALTER TABLE "board_versions" ADD CONSTRAINT "board_versions_board_id_whiteboards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."whiteboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_versions_board_idx" ON "board_versions" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX "whiteboards_template_idx" ON "whiteboards" USING btree ("is_template");