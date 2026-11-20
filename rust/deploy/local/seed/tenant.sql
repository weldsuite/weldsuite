-- The local workspace's people, after `weldsuite migrate --tenants`: an admin
-- (every permission) and a member (the role's defaults). mint-token.mjs signs a
-- token for each. Runs on every `docker compose up`, so it is safe to run
-- again.
insert into workspace_members (id, user_id, email, name, role, permissions, status)
values ('wm_admin', 'user_admin', 'admin@weldsuite.localhost', 'Local Admin', 'ADMIN', '[]', 'ACTIVE'),
       ('wm_member', 'user_member', 'member@weldsuite.localhost', 'Local Member', 'MEMBER', '[]', 'ACTIVE')
on conflict (id) do nothing;

-- With EU test sign-in (eu-test-auth.mjs, the variables of seed/master.sql):
-- you, as the workspace's owner, as onboarding makes the person who creates
-- a workspace.
select :'user_id' <> '' as has_user \gset
\if :has_user
insert into workspace_members (id, user_id, email, name, role, permissions, status, accepted_at)
values ('wm_' || left(md5(:'user_id'), 24), :'user_id', :'email',
        nullif(trim(:'first_name' || ' ' || :'last_name'), ''), 'OWNER', '[]', 'ACTIVE', now())
on conflict (user_id) do update
  set email = excluded.email, name = excluded.name, role = 'OWNER', status = 'ACTIVE',
      deleted_at = null, updated_at = now();
\endif
