# WeldHR — employee operations and the workforce portal

Status: **phase 1 + 2 in progress** on `claude/weldhr-module`. Tenant migration
`0192_weldhr_employee_operations` is written (approved 2026-09-23).

## Why this exists

A BPO prospect (outsourced teams for medium/large companies) wants one portal
where **everyone** works:

- **Clients** (the BPO's customers) see the team on their account, the
  performance numbers and milestones the BPO chooses to share, and can talk to
  the BPO's sales and support people.
- **Employees** (agents) see their own coaching logs, attendance, evaluations,
  goals, leave and onboarding tasks.
- **Internal staff** (HR, ops managers, team leads) run all of it.

Their objection to WeldSuite was branding: management wants something they can
call "our own". So the portal is white-label from day one (logo, colours, name,
no WeldSuite marks, custom domain).

The spine of the data model is **employee ↔ client account**. A client account is
a CRM `companies` row, so sales/support/CRM stay one system.

## Scope

### Phase 1 — back office (platform module)

| Area | What ships |
|---|---|
| Employees | Directory, profile, department, manager, employment type/status, start/end, custom fields. Sensitive block (DOB, national id, address, emergency contact, pay) encrypted with `DATABASE_ENCRYPTION_KEY`, gated by `employees:sensitive`, every read audited. |
| Departments | Flat list with optional parent and head. Org chart derived from `managerId`. |
| Client assignments | Employee → CRM company, role, allocation %, primary flag, date range. History kept (end-date, never delete). |
| Lifecycle | Onboarding/offboarding checklist templates (items with assignee role + due offset in days). Starting a checklist on an employee materialises tasks with real due dates. Employee-visible tasks show in the portal. Completing offboarding flips status to `terminated` and revokes portal access. |
| Attendance | Clock in/out records (portal, manual, import), status (present/late/absent/excused/remote/half day), supervisor approval. Shifts (scheduled start/end, optionally per client account); lateness derived from shift. CSV import. |
| Leave | Leave types (paid, allowance, approval), per-employee allowance overrides, requests with approve/reject, balance = allowance − approved days in the year. |
| Coaching | Coaching logs: date, coach, category, topic, notes, action items, follow-up date, employee acknowledgement + comment, visibility (`internal` / `employee` / `client`). |
| Evaluations | Scorecard forms (weighted criteria, max score). Evaluations score each criterion → weighted overall %. Draft → submitted → acknowledged. Optional share-with-client. |
| KPIs | KPI definitions (unit, direction, target, optional client-specific). Values per employee per period; manual or CSV import; share-with-client flag. |
| Milestones | Goals/milestones/certifications per employee, status, due/achieved date, share-with-client. |
| Dashboard | Headcount, onboarding in flight, today's attendance, pending leave, open coaching follow-ups, recent evaluations. |
| Clients view | Per CRM company: assigned team, shared KPIs, avg evaluation score, milestones. What the client will see in the portal, previewed. |

### Phase 2 — branded workforce portal

- Public API `/public/hr-portal/*` on app-api, same model as
  `public-commerce-portal`: tenant from slug / host, **email OTP** sign-in,
  hashed session token in KV, every query scoped to the signed-in principal.
- Two principals from `hr_portal_access`:
  - `employee` → linked `hr_employees` row. Sees only their own records.
  - `client` → CRM person at a company. Sees employees with an **active
    assignment** to that company, and only records flagged shared. Never the
    sensitive block, never internal coaching.
- Settings: enabled, portal name, logo, colours, support email, hide WeldSuite
  branding, custom domain (hostname stored; DNS via WeldHost), whether clients
  see individual scores or only team aggregates.
- Client → support: a request from the client portal becomes a WeldDesk ticket
  linked to the CRM company (phase 3 if the ticket service needs more work).
- New Next.js app `apps/web/hr-portal` (mirrors `apps/web/commerce-portal`).

### Phase 3 — later

CSV/API KPI + attendance connectors, WeldConnect triggers on lifecycle events,
WeldMeet-scheduled coaching sessions, documents with expiry reminders (WeldDrive),
recruitment/ATS, payroll integration, mobile app, analytics in WeldData.

## Architecture

### Data (tenant DB) — `packages/core/db/src/schema/weldhr.ts`

Tenant DB isolation is the workspace boundary (same as `companies`, `people`).
IDs are `varchar(30)` via `generateId(prefix)`.

| Table | Prefix | Notes |
|---|---|---|
| `hr_departments` | `hrdep` | name, parentId, headEmployeeId, color |
| `hr_employees` | `hremp` | identity, org, employment, `userId` (Clerk, optional), `sensitiveEncrypted` text, customFields jsonb, soft delete |
| `hr_client_assignments` | `hrasg` | employeeId, companyId, role, allocationPercent, isPrimary, startDate, endDate |
| `hr_checklist_templates` | `hrctp` | name, kind onboarding/offboarding, items jsonb |
| `hr_checklists` | `hrchk` | employeeId, templateId, kind, status, startedAt, completedAt |
| `hr_checklist_tasks` | `hrtsk` | checklistId, employeeId, title, assigneeRole, assigneeUserId, dueDate, completedAt/By, visibleToEmployee, sortOrder |
| `hr_shifts` | `hrshf` | employeeId, companyId, startsAt, endsAt, notes |
| `hr_attendance_records` | `hratt` | employeeId, companyId, date, clockIn, clockOut, breakMinutes, status, source, approvedBy/At |
| `hr_leave_types` | `hrlvt` | name, color, isPaid, defaultAllowanceDays, requiresApproval |
| `hr_leave_allowances` | `hrlva` | employeeId, leaveTypeId, year, days (unique triple) |
| `hr_leave_requests` | `hrlvr` | employeeId, leaveTypeId, startDate, endDate, days, status, reviewer |
| `hr_coaching_logs` | `hrcch` | employeeId, coachUserId, sessionDate, category, topic, notes, actionItems jsonb, followUpDate, status, visibility, acknowledgedAt, employeeComment |
| `hr_evaluation_forms` | `hrevf` | name, criteria jsonb, isActive |
| `hr_evaluations` | `hrevl` | employeeId, formId, evaluatorUserId, period, scores jsonb, overallScore, status, sharedWithClient |
| `hr_kpi_definitions` | `hrkpi` | name, unit, direction, target, companyId (nullable) |
| `hr_kpi_values` | `hrkpv` | kpiId, employeeId, companyId, periodStart, periodEnd, value, source, sharedWithClient |
| `hr_milestones` | `hrmil` | employeeId, companyId, title, type, status, dueDate, achievedAt, sharedWithClient |
| `hr_portal_settings` | `hrpst` | singleton, branding + toggles |
| `hr_portal_access` | `hrpac` | kind employee/client, employeeId / personId+companyId, email, status |
| `hr_audit_events` | `hraud` | actorId, action, employeeId, metadata — sensitive reads and access changes |

### API — `apps/workers/app-api/src/routes/weldhr/` → `/api/weldhr/*`

One router, split in files per object (`employees.ts`, `attendance.ts`, …),
services in `src/services/weldhr/`. Standard envelopes (`success`, `list`,
cursor pagination). Every mutation publishes an entity event from the
`hr` catalog (`hr_employee`, `hr_attendance`, `hr_leave_request`,
`hr_coaching_log`, `hr_evaluation`, `hr_milestone`, `hr_checklist`,
`hr_client_assignment`, `hr_kpi_value`). **Sensitive fields are never put on
the event payload** — events carry the public projection only.

Public portal: `apps/workers/app-api/src/routes/public-hr-portal/` →
`/public/hr-portal/*`.

### Permissions (object keys, `packages/core/permissions/src/catalog.ts`)

| Object | Actions |
|---|---|
| `employees` | read, create, update, delete, `sensitive`, manage (departments, templates, forms, KPI definitions, leave types, portal settings) |
| `attendance` | read, create, update, delete, approve |
| `leave` | read, create, update, delete, approve |
| `coaching` | read, create, update, delete |
| `evaluations` | read, create, update, delete |

ADMIN gets everything; MEMBER/VIEWER nothing until granted (HR data is
need-to-know). Platform app gate: `weldhr → ['employees','attendance','leave','coaching','evaluations']`.

### Platform — `apps/web/platform/app/weldhr/`, routes `src/routes/weldhr/`

`/weldhr` dashboard · `/weldhr/employees` · `/weldhr/employees/$employeeId`
(tabs: overview, assignments, lifecycle, attendance, leave, coaching,
evaluations, performance, milestones) · `/weldhr/clients` ·
`/weldhr/clients/$companyId` · `/weldhr/attendance` · `/weldhr/leave` ·
`/weldhr/coaching` · `/weldhr/evaluations` · `/weldhr/settings` (departments,
checklist templates, evaluation forms, KPIs, leave types, portal & branding,
portal access).

Client: `@weldsuite/app-api-client/domains/weldhr` + schemas
`@weldsuite/app-api-client/schemas/weldhr`. Hooks:
`hooks/queries/use-weldhr-queries.ts`. i18n: `locales/{en,nl}/weldhr.ts`.

### Registration touch points

`app-api/src/index.ts` (mounts), `routes/onboarding/index.ts` (app list),
`platform/lib/apps/app-registry.ts`, `hooks/use-installed-apps.ts`,
`lib/apps/app-permission-objects.ts`, `components/layout/module-sidebar-configs.tsx`,
`lib/api/use-app-api.ts`, `admin/lib/apps-seed-data.ts`, entity-events
`events/index.ts`, i18n `navigation.ts` + `index.ts` (en, nl).

## Remaining work / decisions for the owner

1. **Tenant migration** — done: `packages/core/db/drizzle/tenant-migrations/0192_weldhr_employee_operations.sql`
   (hand-finished drizzle DDL with IF NOT EXISTS, like 0180+; the tenant snapshot stops at 0179,
   so `drizzle-kit generate` cannot be used without sweeping in unrelated drift). Bundled into
   workspace-worker via `pnpm bundle-migrations`.
2. Custom domain provisioning for the portal (Cloudflare for SaaS custom
   hostname) — setting is stored; wiring the hostname is phase 2b.
3. App catalog row in the master DB (admin seed) so workspaces can install it.
