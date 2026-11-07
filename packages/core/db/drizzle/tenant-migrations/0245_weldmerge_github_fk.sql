ALTER TABLE "github_repo_links" DROP CONSTRAINT IF EXISTS "github_repo_links_connection_id_github_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "github_project_links" DROP CONSTRAINT IF EXISTS "github_project_links_connection_id_github_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_connection_id_merge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."merge_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_project_links" ADD CONSTRAINT "github_project_links_connection_id_merge_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."merge_connections"("id") ON DELETE cascade ON UPDATE no action;