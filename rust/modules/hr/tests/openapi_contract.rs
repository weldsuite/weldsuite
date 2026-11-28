//! What the native WeldHR apps read, held against the file they generate
//! their client from (`apps/mobile-shared/openapi/weldhr.yaml`): every
//! operation in it, sent as the file describes it through the router as the
//! server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). A change to these routes that would
//! break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test's rows have ids starting `hr_oc_` (and its own member), replaced at
//! its start. The caller is Ada, the support lead: her manager is above her,
//! a teammate reports to her, and she runs the team's leave, expenses,
//! sick reports and rosters. The fixtures are SQL (`sqlx::raw_sql`).

use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::flags::WELDHR_PAYROLL;
use weldsuite_catalogs::permission_keys::{
    ABSENCES_READ, ANNOUNCEMENTS_CREATE, ATTENDANCE_READ, DECLARATIONS_APPROVE, DECLARATIONS_READ,
    EMPLOYEES_READ, EMPLOYEES_SELF, LEAVE_APPROVE, LEAVE_READ,
};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_hr::HrState;
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_pipeline::Flags;
use weldsuite_ports::{FlagContext, StaticFlags};

/// Ada, linked to the employee `hr_oc_emp_me`.
const USER: &str = "user_hr_openapi_contract";
/// A member without an employee record.
const NOBODY: &str = "user_hr_openapi_contract_nobody";
const WORKSPACE: &str = "ws_hr_openapi_contract";
const ORG: &str = "org_hr_openapi_contract";
const ME: &str = "hr_oc_emp_me";
const MATE: &str = "hr_oc_emp_mate";

/// What an earlier run left: the fixtures, and what the routes made for the
/// test's employees and member.
const CLEAN: &str = r"
delete from hr_announcement_reads where employee_id like 'hr\_oc\_%' or announcement_id like 'hr\_oc\_%';
delete from hr_announcements where id like 'hr\_oc\_%' or created_by = 'user_hr_openapi_contract';
delete from hr_attendance_records where employee_id like 'hr\_oc\_%';
delete from hr_shift_requests where employee_id like 'hr\_oc\_%';
delete from hr_shifts where employee_id like 'hr\_oc\_%';
delete from hr_open_shifts where id like 'hr\_oc\_%';
delete from hr_leave_requests where employee_id like 'hr\_oc\_%';
delete from hr_leave_allowances where employee_id like 'hr\_oc\_%';
delete from hr_leave_types where id like 'hr\_oc\_%';
delete from hr_declarations where employee_id like 'hr\_oc\_%';
delete from hr_absences where employee_id like 'hr\_oc\_%';
delete from hr_checklist_tasks where employee_id like 'hr\_oc\_%';
delete from hr_checklists where employee_id like 'hr\_oc\_%';
delete from hr_coaching_logs where employee_id like 'hr\_oc\_%';
delete from hr_evaluations where employee_id like 'hr\_oc\_%';
delete from hr_evaluation_forms where id like 'hr\_oc\_%';
delete from hr_payslips where employee_id like 'hr\_oc\_%';
delete from hr_pay_runs where id like 'hr\_oc\_%';
delete from hr_payroll_employers where id like 'hr\_oc\_%';
delete from hr_compensations where employee_id like 'hr\_oc\_%';
delete from hr_audit_events where employee_id like 'hr\_oc\_%' or actor_id = 'user_hr_openapi_contract';
delete from hr_employees where id like 'hr\_oc\_%';
delete from hr_departments where id like 'hr\_oc\_%';
delete from hr_settings;
delete from companies where id like 'hr\_oc\_%';
delete from workspace_members where user_id = 'user_hr_openapi_contract';
";

/// The fixtures, `TODAY` being today in UTC (the routes' day). Every
/// nullable field the apps read gets a value in one row and none in another.
const FIXTURES: &str = r#"
insert into workspace_members (id, user_id, email, name, role, status, member_type) values
    ('hr_oc_wm', 'user_hr_openapi_contract', 'ada.hr-oc@example.test', 'Ada Lovelace', 'ADMIN', 'ACTIVE', 'INTERNAL');
insert into companies (id, name, display_name) values
    ('hr_oc_company', 'Acme Retail B.V.', 'Acme Retail');

-- My HR's switches: clock in without a location, leave and expenses on.
insert into hr_settings (id, employee_self_clock_in, clock_in_requires_location, employee_leave_requests, employee_declarations) values
    ('hr_oc_settings', true, false, true, true);

insert into hr_departments (id, name, description, color) values
    ('hr_oc_dept', 'Customer Support', 'The front line', '#22c55e');
insert into hr_employees (id, employee_number, first_name, last_name, preferred_name, email, phone, avatar_url, pronouns, job_title, department_id, manager_id, user_id, employment_type, status, start_date, location, weekly_hours) values
    ('hr_oc_emp_me', 'E-0042', 'Ada', 'Lovelace', null, 'ada.hr-oc@example.test', '+31 6 1234 5678', null, 'she/her', 'Support lead', 'hr_oc_dept', 'hr_oc_emp_boss', 'user_hr_openapi_contract', 'full_time', 'active', '2021-03-01', 'Amsterdam', 38),
    ('hr_oc_emp_mate', null, 'Grace', 'Hopper', 'Gracie', 'grace.hr-oc@example.test', null, 'https://example.test/grace.png', null, null, 'hr_oc_dept', 'hr_oc_emp_me', 'user_hr_oc_mate', 'part_time', 'active', null, null, 24),
    ('hr_oc_emp_boss', 'E-0001', 'Charles', 'Babbage', null, 'charles.hr-oc@example.test', '+31 20 555 0100', null, 'he/him', 'Head of support', null, null, null, 'full_time', 'onboarding', TODAY - 3, 'Utrecht', null);
insert into hr_compensations (id, employee_id, effective_from, pay_type, amount, period, currency, hours_per_week) values
    ('hr_oc_comp', 'hr_oc_emp_me', '2024-01-01', 'salary', 4200.00, 'month', 'EUR', 38);

-- Shifts: yesterday's, one under way, a second one under way to switch to,
-- tomorrow's, and the teammate's.
insert into hr_shifts (id, employee_id, company_id, starts_at, ends_at, work_type, break_starts_at, break_ends_at, notes, created_by) values
    ('hr_oc_shift_y', 'hr_oc_emp_me', 'hr_oc_company', (TODAY - 1 + time '08:00') at time zone 'utc', (TODAY - 1 + time '16:00') at time zone 'utc', 'office', (TODAY - 1 + time '12:00') at time zone 'utc', (TODAY - 1 + time '12:30') at time zone 'utc', 'Front desk', 'user_hr_openapi_contract'),
    ('hr_oc_shift_a', 'hr_oc_emp_me', 'hr_oc_company', now() - interval '2 hours', now() + interval '6 hours', 'office', now() + interval '1 hour', now() + interval '90 minutes', 'Front desk', 'user_hr_openapi_contract'),
    ('hr_oc_shift_b', 'hr_oc_emp_me', null, now() - interval '30 minutes', now() + interval '2 hours', null, null, null, null, null),
    ('hr_oc_shift_c', 'hr_oc_emp_me', 'hr_oc_company', now() + interval '1 day', now() + interval '1 day 8 hours', 'remote', null, null, null, 'user_hr_openapi_contract'),
    ('hr_oc_shift_mate', 'hr_oc_emp_mate', null, now() + interval '1 day', now() + interval '1 day 4 hours', 'warehouse', null, null, 'Inventory', 'user_hr_openapi_contract');
insert into hr_attendance_records (id, employee_id, company_id, shift_id, date, clock_in, clock_out, break_minutes, worked_minutes, late_minutes, status, source, notes, approved_by, approved_at, created_by) values
    ('hr_oc_att_me', 'hr_oc_emp_me', 'hr_oc_company', 'hr_oc_shift_y', TODAY - 1, (TODAY - 1 + time '08:02') at time zone 'utc', (TODAY - 1 + time '16:05') at time zone 'utc', 30, 453, 0, 'present', 'manual', 'Covered the late shift', 'user_hr_openapi_contract', now() - interval '12 hours', 'user_hr_openapi_contract'),
    ('hr_oc_att_mate', 'hr_oc_emp_mate', null, null, TODAY - 1, (TODAY - 1 + time '09:20') at time zone 'utc', null, 0, null, 20, 'late', 'portal', null, null, null, 'user_hr_oc_mate');
insert into hr_shift_requests (id, employee_id, open_shift_id, starts_at, ends_at, work_type, note, status, requested_by, reviewed_by, reviewed_at, review_note) values
    ('hr_oc_srq_rejected', 'hr_oc_emp_me', null, (TODAY + 2 + time '10:00') at time zone 'utc', (TODAY + 2 + time '14:00') at time zone 'utc', 'office', 'Can cover the morning', 'rejected', 'user_hr_openapi_contract', 'user_hr_openapi_contract', now() - interval '1 day', 'Fully staffed that day');
insert into hr_open_shifts (id, company_id, department_id, starts_at, ends_at, work_type, break_starts_at, break_ends_at, notes, spots, status, created_by) values
    ('hr_oc_open_1', 'hr_oc_company', 'hr_oc_dept', (TODAY + 5 + time '08:00') at time zone 'utc', (TODAY + 5 + time '16:00') at time zone 'utc', 'warehouse', (TODAY + 5 + time '12:00') at time zone 'utc', (TODAY + 5 + time '12:30') at time zone 'utc', 'Inventory count', 2, 'open', 'user_hr_openapi_contract'),
    ('hr_oc_open_2', null, null, (TODAY + 6 + time '18:00') at time zone 'utc', (TODAY + 6 + time '23:00') at time zone 'utc', null, null, null, null, 1, 'open', null);

-- Leave: a type that needs approval (with this year's allowance) and one
-- that doesn't; past leave, and the teammate's pending and approved days.
insert into hr_leave_types (id, name, color, is_paid, requires_approval, default_allowance_days, over_allowance, is_active) values
    ('hr_oc_lvt_annual', 'Annual leave (contract test)', '#3b82f6', true, true, 25, 'allow', true),
    ('hr_oc_lvt_unpaid', 'Unpaid leave (contract test)', null, false, false, null, 'block', true);
insert into hr_leave_allowances (id, employee_id, leave_type_id, year, days) values
    ('hr_oc_alw', 'hr_oc_emp_me', 'hr_oc_lvt_annual', extract(year from TODAY)::int, 26.5);
insert into hr_leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, reason, status, requested_by, reviewed_by, reviewed_at, review_note) values
    ('hr_oc_lvr_past', 'hr_oc_emp_me', 'hr_oc_lvt_annual', TODAY - 40, TODAY - 38, 3, null, 'approved', 'user_hr_openapi_contract', null, now() - interval '41 days', 'Enjoy'),
    ('hr_oc_lvr_mate', 'hr_oc_emp_mate', 'hr_oc_lvt_annual', TODAY + 10, TODAY + 11, 2, 'Family visit', 'pending', 'user_hr_oc_mate', null, null, null),
    ('hr_oc_lvr_mate_half', 'hr_oc_emp_mate', 'hr_oc_lvt_unpaid', TODAY + 30, TODAY + 30, 0.5, null, 'approved', 'user_hr_oc_mate', 'user_hr_openapi_contract', now() - interval '2 days', null);

-- Expenses: paid with a receipt, approved, pending, and the teammate's.
insert into hr_declarations (id, employee_id, expense_date, category, description, amount, currency, status, receipt_file_key, receipt_file_name, receipt_content_type, receipt_size, submitted_by, reviewed_by, reviewed_at, review_note, paid_by, paid_at) values
    ('hr_oc_dcl_paid', 'hr_oc_emp_me', TODAY - 20, 'travel', 'Train to Utrecht', 23.40, 'EUR', 'paid', 'workspaces/org_hr_openapi_contract/hr/receipts/hr_oc_dcl_paid.pdf', 'ticket.pdf', 'application/pdf', 2048, 'user_hr_openapi_contract', 'user_hr_openapi_contract', now() - interval '18 days', null, 'user_hr_openapi_contract', now() - interval '10 days'),
    ('hr_oc_dcl_approved', 'hr_oc_emp_me', TODAY - 10, 'meals', 'Team lunch', 61.00, 'USD', 'approved', null, null, null, null, 'user_hr_openapi_contract', 'user_hr_openapi_contract', now() - interval '8 days', 'Thanks for organising', null, null),
    ('hr_oc_dcl_pending', 'hr_oc_emp_me', TODAY - 3, 'equipment', 'USB-C hub', 39.95, 'EUR', 'pending', null, null, null, null, 'user_hr_openapi_contract', null, null, null, null, null),
    ('hr_oc_dcl_mate', 'hr_oc_emp_mate', TODAY - 5, 'accommodation', 'Hotel Rotterdam', 129.00, 'EUR', 'pending', null, null, null, null, 'user_hr_oc_mate', null, null, null, null, null);

-- Sick reports: one of hers, long over; the teammate is sick now.
insert into hr_absences (id, employee_id, start_date, end_date, first_day, note, reported_by, recovered_reported_by, recovered_reported_at) values
    ('hr_oc_abs_past', 'hr_oc_emp_me', TODAY - 70, TODAY - 66, 'full', null, 'user_hr_openapi_contract', 'user_hr_openapi_contract', now() - interval '65 days'),
    ('hr_oc_abs_mate', 'hr_oc_emp_mate', TODAY - 1, null, 'half', 'Flu', 'user_hr_oc_mate', null, null);

-- Onboarding: her task, one HR did, and a hidden one IT did.
insert into hr_checklists (id, employee_id, template_id, kind, name, status, anchor_date, started_by) values
    ('hr_oc_chk', 'hr_oc_emp_me', null, 'onboarding', 'Welcome to the team', 'in_progress', TODAY - 3, 'user_hr_openapi_contract');
insert into hr_checklist_tasks (id, checklist_id, employee_id, title, description, assignee_role, due_date, visible_to_employee, sort_order, completed_at, completed_by) values
    ('hr_oc_task_mine', 'hr_oc_chk', 'hr_oc_emp_me', 'Add an emergency contact', 'Someone we can call when something happens', 'employee', TODAY + 3, true, 1, null, null),
    ('hr_oc_task_hr', 'hr_oc_chk', 'hr_oc_emp_me', 'Collect ID and tax documents', null, 'hr', null, true, 0, now() - interval '1 day', 'user_hr_openapi_contract'),
    ('hr_oc_task_it', 'hr_oc_chk', 'hr_oc_emp_me', 'Order a laptop', null, 'it', TODAY - 5, false, 2, now() - interval '2 days', 'user_hr_openapi_contract');

-- Coaching: open with action items, acknowledged, and internal (not hers to see).
insert into hr_coaching_logs (id, employee_id, company_id, coach_user_id, coach_name, session_date, category, topic, notes, action_items, follow_up_date, status, visibility, acknowledged_at, employee_comment) values
    ('hr_oc_coach_open', 'hr_oc_emp_me', 'hr_oc_company', null, 'Charles Babbage', TODAY - 7, 'development', 'Handling escalations', 'Good progress on the hard calls.', '[{"id":"ai_1","text":"Shadow a senior agent","done":false},{"id":"ai_2","text":"Read the escalation guide","done":true}]', TODAY + 14, 'open', 'employee', null, null),
    ('hr_oc_coach_done', 'hr_oc_emp_me', null, 'user_hr_openapi_contract', null, TODAY - 30, 'recognition', 'Customer praise', null, '[]', null, 'acknowledged', 'client', now() - interval '29 days', 'Thank you!'),
    ('hr_oc_coach_internal', 'hr_oc_emp_me', null, 'user_hr_openapi_contract', null, TODAY - 2, 'performance', 'Notes for HR', null, '[]', null, 'open', 'internal', null, null);

-- Evaluations: submitted (one criterion not scored), acknowledged on a
-- deleted form, and a draft (not hers to see yet).
insert into hr_evaluation_forms (id, name, description, criteria, is_active) values
    ('hr_oc_form', 'Quarterly review', null, '[{"id":"quality","label":"Quality of work","weight":60,"maxScore":5},{"id":"teamwork","label":"Teamwork","weight":40,"maxScore":5}]', true);
insert into hr_evaluations (id, employee_id, form_id, company_id, evaluator_user_id, evaluator_name, period_start, period_end, criteria, scores, overall_score, summary, status, shared_with_client, submitted_at, acknowledged_at, employee_comment) values
    ('hr_oc_eval_submitted', 'hr_oc_emp_me', 'hr_oc_form', 'hr_oc_company', null, 'Charles Babbage', TODAY - 90, TODAY - 1, '[{"id":"quality","label":"Quality of work","weight":60,"maxScore":5},{"id":"teamwork","label":"Teamwork","weight":40,"maxScore":5}]', '[{"criterionId":"quality","score":4.5},{"criterionId":"teamwork","score":null}]', 4.5, 'A strong quarter.', 'submitted', false, now() - interval '1 day', null, null),
    ('hr_oc_eval_acknowledged', 'hr_oc_emp_me', 'hr_oc_form_gone', null, 'user_hr_openapi_contract', null, null, null, '[]', '[]', null, null, 'acknowledged', false, null, now() - interval '100 days', 'Agreed'),
    ('hr_oc_eval_draft', 'hr_oc_emp_me', 'hr_oc_form', null, 'user_hr_openapi_contract', null, null, null, '[]', '[]', null, null, 'draft', false, null, null, null);

-- Announcements: one for her department, one for another.
insert into hr_announcements (id, title, body, pinned, department_ids, published_at, created_by) values
    ('hr_oc_ann_dept', 'Clocking from your phone', 'Clock in from the app from Monday. Ask your lead if you are unsure.', false, '["hr_oc_dept"]', now() - interval '1 day', null),
    ('hr_oc_ann_other', 'Warehouse only', 'Not for support.', false, '["hr_oc_dept_other"]', now() - interval '2 days', 'user_hr_openapi_contract');

-- Payroll: a Dutch payslip she hasn't opened, an American one she has, and
-- a draft (not final, not hers to see).
insert into hr_payroll_employers (id, name, legal_name, country, currency) values
    ('hr_oc_employer_nl', 'WeldSuite Nederland', 'WeldSuite Nederland B.V.', 'NL', 'EUR'),
    ('hr_oc_employer_us', 'WeldSuite US', 'WeldSuite Inc.', 'US', 'USD');
insert into hr_pay_runs (id, employer_id, country, currency, period_start, period_end, pay_date, tax_year, period_number, status, employee_count) values
    ('hr_oc_run_nl', 'hr_oc_employer_nl', 'NL', 'EUR', '2026-10-01', '2026-10-31', '2026-10-25', 2026, 10, 'paid', 1),
    ('hr_oc_run_us', 'hr_oc_employer_us', 'US', 'USD', '2025-12-16', '2025-12-31', '2025-12-31', 2025, 24, 'paid', 1),
    ('hr_oc_run_draft', 'hr_oc_employer_nl', 'NL', 'EUR', '2026-11-01', '2026-11-30', '2026-11-25', 2026, 11, 'draft', 1);
insert into hr_payslips (id, run_id, employee_id, employer_id, country, currency, status, number, period_start, period_end, pay_date, tax_year, period_number, gross_pay, net_pay, employee_viewed_at) values
    ('hr_oc_slip_nl', 'hr_oc_run_nl', 'hr_oc_emp_me', 'hr_oc_employer_nl', 'NL', 'EUR', 'final', 'NL-2026-0010', '2026-10-01', '2026-10-31', '2026-10-25', 2026, 10, 4200.00, 3012.55, null),
    ('hr_oc_slip_us', 'hr_oc_run_us', 'hr_oc_emp_me', 'hr_oc_employer_us', 'US', 'USD', 'final', null, '2025-12-16', '2025-12-31', '2025-12-31', 2025, 24, 5000.5, 3720.1, now() - interval '300 days'),
    ('hr_oc_slip_draft', 'hr_oc_run_draft', 'hr_oc_emp_me', 'hr_oc_employer_nl', 'NL', 'EUR', 'draft', null, '2026-11-01', '2026-11-30', '2026-11-25', 2026, 11, 4200.00, 3012.55, null);
"#;

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

/// `/api/weldhr` behind the session, tenant, permission and flag layers, for
/// `user`. The permissions are the keys these routes check, so a route that
/// starts asking for another fails here; the caller is the owner so every
/// legal entity is in reach whatever other tests left in the shared tenant
/// database. Payroll (`weldhr-payroll`) is on.
fn app(db: PgPool, user: &'static str) -> Router {
    let state = HrState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        files: None,
        mail: None,
        http: None,
        master: None,
        books: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [
            EMPLOYEES_SELF,
            EMPLOYEES_READ,
            LEAVE_READ,
            LEAVE_APPROVE,
            DECLARATIONS_READ,
            DECLARATIONS_APPROVE,
            ABSENCES_READ,
            ATTENDANCE_READ,
            ANNOUNCEMENTS_CREATE,
        ]
        .map(str::to_owned)
        .to_vec(),
        role: "OWNER".to_owned(),
        is_owner: true,
        ..ResolvedPermissions::default()
    };
    let flags = Flags::new(
        Arc::new(StaticFlags::new().with(WELDHR_PAYROLL.key, json!(true))),
        FlagContext {
            workspace_id: WORKSPACE.to_owned(),
            clerk_org_id: Some(ORG.to_owned()),
            user_id: user.to_owned(),
        },
    );
    Router::new()
        .nest("/api/weldhr", weldsuite_hr::router(state, &gate))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                let extensions = request.extensions_mut();
                extensions.insert(AuthContext {
                    user_id: user.to_owned(),
                    org_id: Some(ORG.to_owned()),
                    session_id: "sess_hr_openapi_contract".to_owned(),
                    factor_verification_age: None,
                });
                extensions.insert(Tenant {
                    workspace_id: WORKSPACE.to_owned(),
                    clerk_org_id: Some(ORG.to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                extensions.insert(Permissions::new(
                    resolved.clone(),
                    None,
                    false,
                    user.to_owned(),
                ));
                extensions.insert(flags.clone());
                next.run(request)
            },
        ))
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 4).expect("tenant pool"))
}

/// Today (UTC, the routes' day) plus `offset` days, `YYYY-MM-DD`.
fn day(offset: i64) -> String {
    let date = OffsetDateTime::now_utc().date() + Duration::days(offset);
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// [`day`] at `hour`:00 UTC, as the apps send an instant.
fn at(offset: i64, hour: u8) -> String {
    format!("{}T{hour:02}:00:00.000Z", day(offset))
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// The entry of `list` (an array) with `id`.
fn entry<'a>(list: &'a Value, id: &str) -> &'a Value {
    list.as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
        .unwrap_or_else(|| panic!("{id} is not in {list}"))
}

/// Every operation of weldhr.yaml, with data that gives each nullable field
/// a value and none: a member without an employee record and one with, a
/// clock-in, a switch and a clock-out, leave, rosters, expenses, sick
/// reports, onboarding, coaching, evaluations and payslips, and the team's
/// views of them.
#[tokio::test]
async fn weldhr_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    sqlx::raw_sql(CLEAN).execute(&db).await.expect("clean");
    // Constants only: the fixtures with their day filled in.
    let fixtures = FIXTURES.replace("TODAY", "(now() at time zone 'utc')::date");
    sqlx::raw_sql(sqlx::AssertSqlSafe(fixtures))
        .execute(&db)
        .await
        .expect("fixtures");
    let nobody = app(db.clone(), NOBODY);
    let app = app(db, USER);
    let contract = Contract::load("weldhr");

    profile_and_directory(&contract, &app, &nobody).await;
    clocking(&contract, &app).await;
    rosters(&contract, &app).await;
    leave(&contract, &app).await;
    announcements(&contract, &app).await;
    sick_reports(&contract, &app).await;
    expenses(&contract, &app).await;
    onboarding_and_reviews(&contract, &app).await;
    payroll(&contract, &app).await;
    contract
        .success(&app, "getMyOverview", &[], &[], None)
        .await;

    contract.finish();
}

/// Who the caller is, and the directory.
async fn profile_and_directory(contract: &Contract, app: &Router, nobody: &Router) {
    let unlinked = contract.success(nobody, "getMe", &[], &[], None).await;
    assert!(unlinked["data"]["employee"].is_null(), "{unlinked}");
    let me = contract.success(app, "getMe", &[], &[], None).await;
    assert_eq!(me["data"]["employee"]["id"], ME, "{me}");
    assert_eq!(me["data"]["features"]["selfClockIn"], true, "{me}");

    let team = contract
        .success(
            app,
            "listEmployees",
            &[],
            &[("status", "active"), ("search", "hr-oc"), ("limit", "50")],
            None,
        )
        .await;
    assert_eq!(team["data"].as_array().map(Vec::len), Some(2), "{team}");
    contract
        .success(app, "listEmployees", &[], &[("limit", "200")], None)
        .await;
    let lead = contract
        .success(app, "getEmployee", &[("id", ME)], &[], None)
        .await;
    assert_eq!(lead["data"]["directReports"][0]["id"], MATE, "{lead}");
    contract
        .success(app, "getEmployee", &[("id", MATE)], &[], None)
        .await;
    let missing = contract
        .failure(app, "getEmployee", &[("id", "hr_oc_emp_missing")], None)
        .await;
    assert_eq!(missing.status, 404);
}

/// Clocking in on the shift under way, over to the other one and out, with
/// requests in between so every clock-out comes after its clock-in.
async fn clocking(contract: &Contract, app: &Router) {
    let not_in = contract
        .failure(app, "clockMe", &[], Some(&json!({ "action": "out" })))
        .await;
    assert_eq!(not_in.status, 409);
    let before = contract.success(app, "getMyOverview", &[], &[], None).await;
    assert_eq!(before["data"]["clock"]["clockedIn"], false, "{before}");

    let clocked_in = contract
        .success(app, "clockMe", &[], &[], Some(&json!({ "action": "in" })))
        .await;
    assert_eq!(clocked_in["data"]["status"], "late", "{clocked_in}");
    let during = contract.success(app, "getMyOverview", &[], &[], None).await;
    assert_eq!(
        during["data"]["clock"]["shiftId"], "hr_oc_shift_a",
        "{during}"
    );
    let (from, to) = (day(-7), day(7));
    contract
        .success(
            app,
            "getMyAttendance",
            &[],
            &[("from", from.as_str()), ("to", to.as_str())],
            None,
        )
        .await;
    contract
        .success(
            app,
            "clockMe",
            &[],
            &[],
            Some(&json!({ "action": "switch", "shiftId": "hr_oc_shift_b" })),
        )
        .await;
    contract
        .success(app, "getMyAttendance", &[], &[], None)
        .await;
    let out = contract
        .success(app, "clockMe", &[], &[], Some(&json!({ "action": "out" })))
        .await;
    assert!(out["data"]["clockOut"].is_string(), "{out}");
}

/// Asking for shifts, signing up for an open one, and the team's roster.
async fn rosters(contract: &Contract, app: &Router) {
    let asked = contract
        .success(
            app,
            "requestShift",
            &[],
            &[],
            Some(&json!({
                "startsAt": at(3, 9),
                "endsAt": at(3, 17),
                "workType": "office",
                "note": "Happy to cover",
            })),
        )
        .await;
    assert_eq!(asked["data"]["status"], "pending", "{asked}");
    let second = contract
        .success(
            app,
            "requestShift",
            &[],
            &[],
            Some(&json!({ "startsAt": at(4, 10), "endsAt": at(4, 14) })),
        )
        .await;
    contract
        .success(
            app,
            "cancelMyShiftRequest",
            &[("id", id(&second).as_str())],
            &[],
            None,
        )
        .await;

    contract
        .success(app, "listMyOpenShifts", &[], &[], None)
        .await;
    contract
        .success(
            app,
            "signUpForOpenShift",
            &[("id", "hr_oc_open_1")],
            &[],
            Some(&json!({ "note": "I know the stockroom" })),
        )
        .await;
    let open = contract
        .success(app, "listMyOpenShifts", &[], &[], None)
        .await;
    assert!(
        entry(&open["data"], "hr_oc_open_1")["myRequest"].is_object(),
        "{open}"
    );
    assert!(entry(&open["data"], "hr_oc_open_2")["myRequest"].is_null());

    let (from, to) = (day(-7), day(7));
    let mine = contract
        .success(
            app,
            "getMyAttendance",
            &[],
            &[("from", from.as_str()), ("to", to.as_str())],
            None,
        )
        .await;
    entry(&mine["data"]["requests"], "hr_oc_srq_rejected");

    let (from, to) = (day(-1), day(6));
    contract
        .success(
            app,
            "listShifts",
            &[],
            &[("from", from.as_str()), ("to", to.as_str())],
            None,
        )
        .await;
    let (from, to) = (day(-7), day(0));
    contract
        .success(
            app,
            "listAttendance",
            &[],
            &[
                ("from", from.as_str()),
                ("to", to.as_str()),
                ("limit", "200"),
            ],
            None,
        )
        .await;
}

/// Her leave (asked, approved at once, withdrawn) and the team's.
async fn leave(contract: &Contract, app: &Router) {
    contract.success(app, "getMyLeave", &[], &[], None).await;
    let asked = contract
        .success(
            app,
            "requestLeave",
            &[],
            &[],
            Some(&json!({
                "leaveTypeId": "hr_oc_lvt_annual",
                "startDate": day(21),
                "endDate": day(27),
                "reason": "Holiday",
            })),
        )
        .await;
    assert_eq!(asked["data"]["status"], "pending", "{asked}");
    let unpaid = contract
        .success(
            app,
            "requestLeave",
            &[],
            &[],
            Some(&json!({
                "leaveTypeId": "hr_oc_lvt_unpaid",
                "startDate": day(45),
                "endDate": day(51),
                "reason": null,
            })),
        )
        .await;
    assert_eq!(unpaid["data"]["status"], "approved", "{unpaid}");
    contract.success(app, "getMyLeave", &[], &[], None).await;
    let asked = id(&asked);
    contract
        .success(app, "cancelMyLeave", &[("id", asked.as_str())], &[], None)
        .await;
    let again = contract
        .failure(app, "cancelMyLeave", &[("id", asked.as_str())], None)
        .await;
    assert_eq!(again.status, 409);
    let invalid = contract
        .failure(app, "requestLeave", &[], Some(&json!({})))
        .await;
    assert_eq!(invalid.status, 400);

    let pending = contract
        .success(
            app,
            "listLeaveRequests",
            &[],
            &[("status", "pending")],
            None,
        )
        .await;
    entry(&pending["data"], "hr_oc_lvr_mate");
    contract
        .success(
            app,
            "reviewLeaveRequest",
            &[("id", "hr_oc_lvr_mate")],
            &[],
            Some(&json!({ "decision": "approved", "note": "Have fun" })),
        )
        .await;
    let (from, to) = (day(-60), day(60));
    contract
        .success(
            app,
            "listLeaveRequests",
            &[],
            &[
                ("status", "approved"),
                ("from", from.as_str()),
                ("to", to.as_str()),
            ],
            None,
        )
        .await;
}

/// Posting one, and reading it (twice: the first time stays).
async fn announcements(contract: &Contract, app: &Router) {
    let posted = contract
        .success(
            app,
            "createAnnouncement",
            &[],
            &[],
            Some(&json!({
                "title": "Summer schedule",
                "body": "Shifts start an hour earlier\nfrom July.",
                "pinned": true,
                "notify": false,
            })),
        )
        .await;
    let posted = id(&posted);
    let unread = contract
        .success(app, "listMyAnnouncements", &[], &[], None)
        .await;
    assert!(
        entry(&unread["data"]["announcements"], &posted)["readAt"].is_null(),
        "{unread}"
    );
    contract
        .success(
            app,
            "markAnnouncementRead",
            &[("id", posted.as_str())],
            &[],
            None,
        )
        .await;
    contract
        .success(
            app,
            "markAnnouncementRead",
            &[("id", posted.as_str())],
            &[],
            None,
        )
        .await;
    let read = contract
        .success(app, "listMyAnnouncements", &[], &[], None)
        .await;
    assert!(
        entry(&read["data"]["announcements"], &posted)["readAt"].is_string(),
        "{read}"
    );
    let elsewhere = contract
        .failure(
            app,
            "markAnnouncementRead",
            &[("id", "hr_oc_ann_other")],
            None,
        )
        .await;
    assert_eq!(elsewhere.status, 404);
}

/// Reporting sick and better, and the team's sick reports.
async fn sick_reports(contract: &Contract, app: &Router) {
    let well = contract.success(app, "getMyAbsences", &[], &[], None).await;
    assert!(well["data"]["current"].is_null(), "{well}");
    let sick = contract
        .success(
            app,
            "reportSick",
            &[],
            &[],
            Some(&json!({ "startDate": day(-2), "firstDay": "half", "note": "Migraine" })),
        )
        .await;
    let sick = id(&sick);
    let ill = contract.success(app, "getMyAbsences", &[], &[], None).await;
    assert_eq!(ill["data"]["current"]["id"], sick.as_str(), "{ill}");
    contract
        .success(
            app,
            "listAbsences",
            &[],
            &[("status", "ongoing"), ("limit", "50")],
            None,
        )
        .await;
    contract
        .success(
            app,
            "reportRecovered",
            &[("id", sick.as_str())],
            &[],
            Some(&json!({ "endDate": day(-1) })),
        )
        .await;
    contract.success(app, "getMyAbsences", &[], &[], None).await;
    contract
        .success(app, "listAbsences", &[], &[("limit", "100")], None)
        .await;
}

/// Filing and withdrawing an expense, and reviewing the team's.
async fn expenses(contract: &Contract, app: &Router) {
    contract
        .success(app, "getMyDeclarations", &[], &[], None)
        .await;
    let filed = contract
        .success(
            app,
            "createDeclaration",
            &[],
            &[],
            Some(&json!({
                "amount": 12.5,
                "currency": "GBP",
                "expenseDate": day(0),
                "category": "other",
                "description": "Parking at the client",
            })),
        )
        .await;
    assert_eq!(filed["data"]["hasReceipt"], false, "{filed}");
    contract
        .success(
            app,
            "cancelMyDeclaration",
            &[("id", id(&filed).as_str())],
            &[],
            None,
        )
        .await;

    let pending = contract
        .success(app, "listDeclarations", &[], &[("status", "pending")], None)
        .await;
    entry(&pending["data"], "hr_oc_dcl_mate");
    contract
        .success(
            app,
            "reviewDeclaration",
            &[("id", "hr_oc_dcl_mate")],
            &[],
            Some(&json!({ "decision": "approved", "note": null })),
        )
        .await;
    contract
        .success(
            app,
            "reviewDeclaration",
            &[("id", "hr_oc_dcl_pending")],
            &[],
            Some(&json!({ "decision": "rejected", "note": "Please use the company card" })),
        )
        .await;
    contract
        .success(app, "getMyDeclarations", &[], &[], None)
        .await;
}

/// Her onboarding task (done, then open again), coaching and evaluations.
async fn onboarding_and_reviews(contract: &Contract, app: &Router) {
    contract.success(app, "listMyTasks", &[], &[], None).await;
    let done = contract
        .success(
            app,
            "completeMyTask",
            &[("id", "hr_oc_task_mine")],
            &[],
            None,
        )
        .await;
    assert_eq!(done["data"]["checklistCompleted"], true, "{done}");
    contract.success(app, "listMyTasks", &[], &[], None).await;
    let reopened = contract
        .success(
            app,
            "completeMyTask",
            &[("id", "hr_oc_task_mine")],
            &[("undo", "true")],
            None,
        )
        .await;
    assert_eq!(reopened["data"]["checklistCompleted"], false, "{reopened}");

    contract
        .success(app, "listMyCoaching", &[], &[], None)
        .await;
    contract
        .success(
            app,
            "acknowledgeCoaching",
            &[("id", "hr_oc_coach_open")],
            &[],
            Some(&json!({ "comment": "Will do" })),
        )
        .await;
    let coaching = contract
        .success(app, "listMyCoaching", &[], &[], None)
        .await;
    assert_eq!(
        coaching["data"].as_array().map(Vec::len),
        Some(2),
        "{coaching}"
    );

    contract
        .success(app, "listMyEvaluations", &[], &[], None)
        .await;
    contract
        .success(
            app,
            "acknowledgeEvaluation",
            &[("id", "hr_oc_eval_submitted")],
            &[],
            Some(&json!({})),
        )
        .await;
    let evaluations = contract
        .success(app, "listMyEvaluations", &[], &[], None)
        .await;
    assert_eq!(
        evaluations["data"].as_array().map(Vec::len),
        Some(2),
        "{evaluations}"
    );
}

/// Her final payslips and the annual statements they make.
async fn payroll(contract: &Contract, app: &Router) {
    let payslips = contract
        .success(app, "listMyPayslips", &[], &[], None)
        .await;
    assert_eq!(
        payslips["data"].as_array().map(Vec::len),
        Some(2),
        "{payslips}"
    );
    let statements = contract
        .success(app, "listMyAnnualStatements", &[], &[], None)
        .await;
    assert_eq!(
        statements["data"].as_array().map(Vec::len),
        Some(2),
        "{statements}"
    );
}
