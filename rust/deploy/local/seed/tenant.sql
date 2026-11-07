-- The local workspace's people, after `weldsuite migrate --tenants`: an admin
-- (every permission) and a member (the role's defaults). mint-token.mjs signs a
-- token for each. Safe to run again.
insert into workspace_members (id, user_id, email, name, role, permissions, status)
values ('wm_admin', 'user_admin', 'admin@weldsuite.localhost', 'Local Admin', 'ADMIN', '[]', 'ACTIVE'),
       ('wm_member', 'user_member', 'member@weldsuite.localhost', 'Local Member', 'MEMBER', '[]', 'ACTIVE')
on conflict (id) do nothing;
