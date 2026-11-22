-- WeldFlow and WeldConnect move from github_connections to merge_connections
-- (ADR MERGE-002). Copy every github_connections row into merge_connections,
-- keeping its id, then point links at an installation WeldMerge adopted in
-- phase 1 (with a different id) to that row. github_connections stays, unread.
-- Idempotent: every statement guards on what already exists.
-- The links' foreign keys to github_connections go first: a link repointed
-- below names a merge_connections id (0245 adds the keys to that table).
ALTER TABLE "github_repo_links" DROP CONSTRAINT IF EXISTS "github_repo_links_connection_id_github_connections_id_fk";--> statement-breakpoint
ALTER TABLE "github_project_links" DROP CONSTRAINT IF EXISTS "github_project_links_connection_id_github_connections_id_fk";--> statement-breakpoint
INSERT INTO "merge_connections" (
	"id", "provider", "external_account_id", "account_login", "account_type", "status",
	"webhook_secret", "app_slug", "scopes", "installed_at", "revoked_at",
	"created_by_user_id", "created_at", "updated_at", "deleted_at"
)
SELECT
	g."id",
	'github',
	g."installation_id"::text,
	g."owner_login",
	CASE WHEN g."owner_type" = 'org' THEN 'organization' ELSE 'user' END,
	g."status",
	g."webhook_secret",
	g."app_slug",
	g."scopes",
	g."installed_at" AT TIME ZONE 'UTC',
	g."revoked_at" AT TIME ZONE 'UTC',
	COALESCE(g."created_by", 'system'),
	g."created_at" AT TIME ZONE 'UTC',
	g."updated_at" AT TIME ZONE 'UTC',
	g."deleted_at" AT TIME ZONE 'UTC'
FROM "github_connections" g
WHERE NOT EXISTS (SELECT 1 FROM "merge_connections" m WHERE m."id" = g."id")
	AND (
		g."deleted_at" IS NOT NULL
		OR NOT EXISTS (
			SELECT 1 FROM "merge_connections" m
			WHERE m."provider" = 'github'
				AND m."external_account_id" = g."installation_id"::text
				AND m."deleted_at" IS NULL
		)
	);--> statement-breakpoint
-- A live row WeldMerge adopted in phase 1 keeps its own id and gains the GitHub App fields.
UPDATE "merge_connections" m
SET
	"webhook_secret" = COALESCE(m."webhook_secret", g."webhook_secret"),
	"app_slug" = COALESCE(m."app_slug", g."app_slug"),
	"scopes" = COALESCE(m."scopes", g."scopes"),
	"installed_at" = COALESCE(m."installed_at", g."installed_at" AT TIME ZONE 'UTC'),
	"revoked_at" = COALESCE(m."revoked_at", g."revoked_at" AT TIME ZONE 'UTC')
FROM "github_connections" g
WHERE m."provider" = 'github'
	AND m."external_account_id" = g."installation_id"::text
	AND m."deleted_at" IS NULL
	AND m."id" <> g."id"
	AND g."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "github_repo_links" l
SET "connection_id" = m."id"
FROM "github_connections" g, "merge_connections" m
WHERE l."connection_id" = g."id"
	AND m."provider" = 'github'
	AND m."external_account_id" = g."installation_id"::text
	AND m."deleted_at" IS NULL
	AND m."id" <> g."id";--> statement-breakpoint
UPDATE "github_project_links" l
SET "connection_id" = m."id"
FROM "github_connections" g, "merge_connections" m
WHERE l."connection_id" = g."id"
	AND m."provider" = 'github'
	AND m."external_account_id" = g."installation_id"::text
	AND m."deleted_at" IS NULL
	AND m."id" <> g."id";
