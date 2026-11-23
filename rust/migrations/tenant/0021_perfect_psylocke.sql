CREATE TABLE "customer_list_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"list_id" varchar(30) NOT NULL,
	"customer_id" varchar(30) NOT NULL,
	CONSTRAINT "customer_list_members_unique_idx" UNIQUE("list_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_lists" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"color" varchar(50) DEFAULT 'bg-blue-500' NOT NULL,
	"icon" varchar(100) DEFAULT 'Building2' NOT NULL,
	"description" varchar(1000)
);
--> statement-breakpoint
CREATE INDEX "customer_list_members_list_id_idx" ON "customer_list_members" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "customer_list_members_customer_id_idx" ON "customer_list_members" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_lists_name_idx" ON "customer_lists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customer_lists_deleted_at_idx" ON "customer_lists" USING btree ("deleted_at");