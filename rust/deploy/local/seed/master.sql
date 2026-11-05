-- The local workspace in the master database, after `weldsuite migrate
-- --master`. Its database (`tenant`, on the same Postgres) is made here and
-- migrated next by `weldsuite migrate --tenants`, which finds it through
-- neon_project_id. Safe to run again.
select 'create database tenant'
where not exists (select from pg_database where datname = 'tenant') \gexec

insert into workspaces (id, name, slug, clerk_org_id, neon_project_id, database_url)
values ('ws_local', 'Local workspace', 'local', 'org_local', 'local:postgres',
        'postgres://weldsuite:weldsuite@postgres:5432/tenant')
on conflict (id) do nothing;
