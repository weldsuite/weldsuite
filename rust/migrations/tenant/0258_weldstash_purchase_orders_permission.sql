-- WeldStash purchase orders move from `orders:*` to their own `purchase_orders:*`
-- permission object (`orders:*` now means sales orders; weldsuite-documentation
-- plans/weldcommerce-rebuild.md, phase 2). Nobody gains or loses access: every
-- stored grant (or deny) that reached WeldStash purchase orders through the old
-- key gets its `purchase_orders` twin next to it.
--
--   'weldstash:orders:<action>' -> + 'weldstash:purchase_orders:<action>'
--   'orders:<action>'           -> + 'purchase_orders:<action>'   (unqualified, every app)
--
-- `<action>` includes '*'. Wildcards that already cover the new object
-- ('*', 'weldstash:*', 'weldstash:*:read') need nothing. System roles are
-- answered from code (SYSTEM_ROLES), so their rows are only touched for
-- tidiness. Idempotent: a key that is already there is not added again.
UPDATE "roles" r
SET "permissions" = r."permissions" || a."added"
FROM (
  SELECT t."id", jsonb_agg(DISTINCT k."key") AS "added"
  FROM "roles" t
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN e LIKE 'weldstash:orders:%' THEN 'weldstash:purchase_orders:' || substr(e, 18)
      WHEN e LIKE 'orders:%' THEN 'purchase_orders:' || substr(e, 8)
    END AS "key"
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(t."permissions") = 'array' THEN t."permissions" ELSE '[]'::jsonb END
    ) AS e
  ) k
  WHERE k."key" IS NOT NULL AND NOT jsonb_exists(t."permissions", k."key")
  GROUP BY t."id"
) a
WHERE r."id" = a."id";
--> statement-breakpoint
UPDATE "workspace_members" r
SET "permissions" = r."permissions" || a."added"
FROM (
  SELECT t."id", jsonb_agg(DISTINCT k."key") AS "added"
  FROM "workspace_members" t
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN e LIKE 'weldstash:orders:%' THEN 'weldstash:purchase_orders:' || substr(e, 18)
      WHEN e LIKE 'orders:%' THEN 'purchase_orders:' || substr(e, 8)
    END AS "key"
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(t."permissions") = 'array' THEN t."permissions" ELSE '[]'::jsonb END
    ) AS e
  ) k
  WHERE k."key" IS NOT NULL AND NOT jsonb_exists(t."permissions", k."key")
  GROUP BY t."id"
) a
WHERE r."id" = a."id";
--> statement-breakpoint
UPDATE "workspace_members" r
SET "permission_denies" = r."permission_denies" || a."added"
FROM (
  SELECT t."id", jsonb_agg(DISTINCT k."key") AS "added"
  FROM "workspace_members" t
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN e LIKE 'weldstash:orders:%' THEN 'weldstash:purchase_orders:' || substr(e, 18)
      WHEN e LIKE 'orders:%' THEN 'purchase_orders:' || substr(e, 8)
    END AS "key"
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(t."permission_denies") = 'array' THEN t."permission_denies" ELSE '[]'::jsonb END
    ) AS e
  ) k
  WHERE k."key" IS NOT NULL AND NOT jsonb_exists(t."permission_denies", k."key")
  GROUP BY t."id"
) a
WHERE r."id" = a."id";
--> statement-breakpoint
UPDATE "weldagent_agents" r
SET "permissions" = r."permissions" || a."added"
FROM (
  SELECT t."id", jsonb_agg(DISTINCT k."key") AS "added"
  FROM "weldagent_agents" t
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN e LIKE 'weldstash:orders:%' THEN 'weldstash:purchase_orders:' || substr(e, 18)
      WHEN e LIKE 'orders:%' THEN 'purchase_orders:' || substr(e, 8)
    END AS "key"
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(t."permissions") = 'array' THEN t."permissions" ELSE '[]'::jsonb END
    ) AS e
  ) k
  WHERE k."key" IS NOT NULL AND NOT jsonb_exists(t."permissions", k."key")
  GROUP BY t."id"
) a
WHERE r."id" = a."id";
