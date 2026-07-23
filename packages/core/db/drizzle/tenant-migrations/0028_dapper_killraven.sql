ALTER TABLE "user_app_assignments" DROP CONSTRAINT "uq_user_app_assignment";--> statement-breakpoint
ALTER TABLE "workspace_installed_apps" DROP CONSTRAINT "uq_workspace_installed_app";--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_unique";--> statement-breakpoint
ALTER TABLE "workspace_usage" DROP CONSTRAINT "workspace_usage_workspace_id_unique";--> statement-breakpoint
DROP INDEX "workspace_members_workspace_idx";--> statement-breakpoint
DROP INDEX "workspace_usage_workspace_id_idx";--> statement-breakpoint
DROP INDEX "roles_workspace_idx";--> statement-breakpoint
DROP INDEX "api_keys_workspace_idx";--> statement-breakpoint
DROP INDEX "workspace_api_keys_workspace_idx";--> statement-breakpoint
DROP INDEX "notifications_user_workspace_idx";--> statement-breakpoint
DROP INDEX "notification_preferences_user_workspace_idx";--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_idx" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "user_app_assignments" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_installed_apps" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_members" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_usage" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_api_keys" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "user_app_assignments" ADD CONSTRAINT "uq_user_app_assignment" UNIQUE("user_id","app_code");--> statement-breakpoint
ALTER TABLE "workspace_installed_apps" ADD CONSTRAINT "uq_workspace_installed_app" UNIQUE("app_code");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_unique" UNIQUE("user_id");