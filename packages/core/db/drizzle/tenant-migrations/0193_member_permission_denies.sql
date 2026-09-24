-- Per-app permissions: explicit per-member denies (e.g. `weldbooks:companies:read`).
-- A deny always wins over a grant from the member's role or their own extras.
-- Additive with an empty default, so existing members are unaffected.
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "permission_denies" jsonb DEFAULT '[]'::jsonb;
