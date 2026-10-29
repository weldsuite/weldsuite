-- The smoke test's workspace, on the schema the journaled migrations build
-- (scripts/rust-test-db.ts). Applied to the master database, then the tenant
-- database (split by smoke-test.sh at the marker line).

-- master
insert into workspaces (id, name, slug, clerk_org_id, database_url)
values ('ws_smoke', 'Smoke test', 'smoke-test', 'org_smoke',
        'postgres://weldsuite:weldsuite@postgres:5432/tenant');

-- @@tenant@@
insert into workspace_members (id, user_id, email, name, role, permissions, status)
values ('wm_smoke', 'user_smoke', 'smoke@example.com', 'Smoke', 'MEMBER', '["billing:read"]', 'ACTIVE'),
       ('wm_admin', 'user_admin', 'admin@example.com', 'Admin', 'ADMIN', '[]', 'ACTIVE');
insert into access_requests (id, requester_id, permission, status)
values ('areq_smoke', 'user_admin', 'team:read', 'pending');
