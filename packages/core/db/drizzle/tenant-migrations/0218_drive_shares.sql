CREATE TABLE "drive_shares" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"file_id" varchar(255),
	"folder_id" varchar(255),
	"user_id" varchar(255) NOT NULL,
	"role" varchar(20) NOT NULL,
	"shared_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_shares_one_item_check" CHECK (num_nonnulls("drive_shares"."file_id", "drive_shares"."folder_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "general_access" varchar(20) DEFAULT 'workspace_edit' NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "general_access" varchar(20) DEFAULT 'workspace_edit' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_shares_file_user_idx" ON "drive_shares" USING btree ("file_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_shares_folder_user_idx" ON "drive_shares" USING btree ("folder_id","user_id");--> statement-breakpoint
CREATE INDEX "drive_shares_user_idx" ON "drive_shares" USING btree ("user_id");