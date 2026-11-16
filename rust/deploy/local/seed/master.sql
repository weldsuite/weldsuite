-- The local workspace in the master database, after `weldsuite migrate
-- --master`. Its database (`tenant`, on the same Postgres) is made here and
-- migrated next by `weldsuite migrate --tenants`, which finds it through
-- neon_project_id. Runs on every `docker compose up`, so it is safe to run
-- again.
--
-- Variables (compose.yaml passes them from .local/auth.env, which
-- eu-test-auth.mjs writes):
--   org_id      the organization a session token names for this workspace:
--               `org_local` for mint-token.mjs's tokens, or your EU test
--               organization's id when you sign in through EU test's Zitadel
--   user_id     with EU test sign-in: your Zitadel user id (`sub`), made a
--               member of the workspace here and in seed/tenant.sql
--   email, first_name, last_name: that user's profile
select 'create database tenant'
where not exists (select from pg_database where datname = 'tenant') \gexec

-- On Kubernetes `clerk_org_id` holds the identity provider's organization id
-- (ADR SEC-012): the server finds a session's workspace through it.
insert into workspaces (id, name, slug, clerk_org_id, neon_project_id, database_url, provisioning_status)
values ('ws_local', 'Local workspace', 'local', :'org_id', 'local:postgres',
        'postgres://weldsuite:weldsuite@postgres:5432/tenant', 'ready')
on conflict (id) do update
  set clerk_org_id = excluded.clerk_org_id, provisioning_status = 'ready', updated_at = now();

-- The workspace switcher's list (`GET /api/workspaces`) comes from these.
select :'user_id' <> '' as has_user \gset
\if :has_user
insert into users (id, email, first_name, last_name)
values (:'user_id', :'email', nullif(:'first_name', ''), nullif(:'last_name', ''))
on conflict (id) do update
  set email = excluded.email, first_name = excluded.first_name,
      last_name = excluded.last_name, is_active = true, updated_at = now();

insert into user_workspaces (id, user_id, workspace_id, role, status, joined_at)
values ('uw_' || left(md5(:'user_id'), 24), :'user_id', 'ws_local', 'org:admin', 'ACTIVE', now())
on conflict (user_id, workspace_id) do update
  set role = 'org:admin', status = 'ACTIVE', updated_at = now();
\endif
