CREATE TABLE "custom_field_values" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"field_id" varchar(30) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"value_text" text,
	"value_number" double precision,
	"value_date" timestamp,
	"value_bool" boolean,
	"value_json" jsonb,
	"value_ref" varchar(30)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cfv_entity_field_idx" ON "custom_field_values" USING btree ("entity_type","entity_id","field_id");--> statement-breakpoint
CREATE INDEX "cfv_entity_idx" ON "custom_field_values" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "cfv_field_text_idx" ON "custom_field_values" USING btree ("field_id","value_text");--> statement-breakpoint
CREATE INDEX "cfv_field_number_idx" ON "custom_field_values" USING btree ("field_id","value_number");--> statement-breakpoint
CREATE INDEX "cfv_field_date_idx" ON "custom_field_values" USING btree ("field_id","value_date");--> statement-breakpoint
CREATE INDEX "cfv_field_bool_idx" ON "custom_field_values" USING btree ("field_id","value_bool");--> statement-breakpoint
CREATE INDEX "cfv_field_ref_idx" ON "custom_field_values" USING btree ("field_id","value_ref");