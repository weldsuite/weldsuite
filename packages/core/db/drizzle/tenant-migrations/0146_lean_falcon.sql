ALTER TABLE "crm_templates" RENAME TO "object_templates";--> statement-breakpoint
DROP INDEX "crm_templates_entity_type_idx";--> statement-breakpoint
DROP INDEX "crm_templates_entity_type_slug_idx";--> statement-breakpoint
CREATE INDEX "object_templates_entity_type_idx" ON "object_templates" USING btree ("entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "object_templates_entity_type_slug_idx" ON "object_templates" USING btree ("entity_type","slug");