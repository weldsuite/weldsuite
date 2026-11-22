ALTER TABLE "agents" ADD COLUMN "package_slug" varchar(50) DEFAULT 'weldagent' NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_package_slug_idx" ON "agents" USING btree ("package_slug");