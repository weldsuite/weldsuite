# Where payroll plugs into WeldSuite today

Mapped 8 October 2026 at commit `b3c0ae3cf`. Paths are relative to the repo
root. This file describes what exists and what is missing. It doesn't choose
between prep + export (A), an embedded provider (B) or an own engine (C); most
of the gaps below have to be closed whichever one we pick.

## Summary

- **WeldHR has the inputs payroll needs, but not in a payroll-ready shape.**
  Hours come from attendance (`worked_minutes`, approval) and leave
  (`is_paid`), and the employee record has `startDate`, `endDate` and
  `weeklyHours`. Pay itself is one number plus a period inside the encrypted
  sensitive blob. It has no history, effective dates, components, tax settings
  or structured bank details.
- **Time has three gaps that would produce wrong pay.** Day boundaries are
  UTC. There is no public-holiday calendar: leave counts Monday to Friday only.
  Nothing marks overtime, night or weekend hours.
- **WeldBooks can take a payroll journal, but no other worker can reach it.**
  `postJournalEntry` is idempotent and checks lock dates. It is internal to
  books-api, though: there is no `WorkerEntrypoint` and no payroll account
  roles.
- **Nothing pays anyone.** There is no SEPA pain.001 or Nacha generation and
  no payment-batch model. Bank accounts are IBAN-only.
- **Payslips have a delivery path but no renderer or storage.** The HR portal
  proxy streams files as-is, and the commerce portal's invoice PDF route is a
  precedent. PDFs are made in the browser (`pdf-lib`), and hr-api has no R2
  binding.
- **The connector framework fits provider sync** (encrypted credentials,
  webhooks, polling, sync runs). Today it only covers commerce and
  bookkeeping providers.
- **There is no way to charge for a first-party module.** Billing has plans,
  seats (including the `EMPLOYEE` member type) and credits, but no per-module
  or per-employee price. A paid payroll add-on needs new billing work.
- **Staffing billing doesn't exist yet.** Assignments carry no pay or bill
  rate. Attendance carries a `companyId`, but nothing turns hours into client
  invoices, and WeldFlow time entries never become invoices either.

## 1. WeldHR (hr-api + schema)

| Area | What exists | Gap for payroll |
|---|---|---|
| Employee | `hr_employees` (`packages/core/db/src/schema/weldhr.ts:138`): `employmentType`, `status`, `startDate`, `endDate`, `probationEndDate`, `weeklyHours`, `location`, `timezone`, `userId` (Clerk), `customFields` | No legal employer (which entity employs this person), no work location for tax purposes, no pay schedule |
| Sensitive data | `sensitive_encrypted` with `HrEmployeeSensitive` (`weldhr.ts:42`): `nationalId`, `taxId`, `bankAccount` (one string), `salaryAmount/Currency/Period`. AES-256-GCM with a versioned keyring (`packages/core/db/src/lib/crypto.ts:35,122,139`); services `encryptSensitive` / `readSensitive` / `writeSensitive` (`apps/workers/hr-api/src/services/weldhr/employees.ts:501-520`); routes gated by `employees:sensitive` and audited (`routes/weldhr/employees.ts:151,159`) | Pay as one flat value with no effective dating. No tax profile (NL loonheffingskorting / table, US W-4 and state forms). No structured bank account (IBAN + BIC, or routing + account + type) |
| Attendance | `workedMinutes()` = out − in − break (`services/weldhr/time.ts:144`), lateness against the shift with 5 min grace (l.150), approval fields cleared on edit (l.325), `attendanceSummary` (l.468) | UTC day boundary (`todayIso`, `shiftOn` l.124), so a night shift lands on the wrong day. No pay codes (regular / overtime / night / weekend / on-call). No lock after a pay period closes |
| Shifts | `hr_shifts` with optional `companyId`, max 24 h (`time.ts:85`) | No shift type, paid break, or differential |
| Leave | `hr_leave_types.is_paid`; defaults Annual 20 d, Sick unlimited, Unpaid (`ensureDefaultLeaveTypes`, l.563); `workingDaysBetween` counts Mon to Fri (`services/weldhr/shared.ts:55`); balances per calendar year (l.593) | No public holidays. Days, not hours (NL statutory leave is in hours: 4 × weekly hours). No accrual, carry-over or expiry (NL statutory days lapse after 6 months). Half days only in the back office, not the portal schema (`packages/clients/app-api-client/src/schemas/weldhr.ts:451`). Sick leave has no pay percentage |
| Client assignments | `hr_client_assignments` (`weldhr.ts:183`): company, role, allocation %, primary, dates, end-dated history | No pay rate, bill rate, rate card or PO number |
| Portal | `/public/hr-portal`, email OTP, hashed KV session, `requireSession` re-checks access on every call (`routes/public-hr-portal/index.ts:321`); platform twin `routes/weldhr/me.ts` (`employees:self`) | No documents endpoint. The Next proxy `apps/web/hr-portal/app/api/portal/[...path]/route.ts` passes `content-type` and `content-disposition` through, so a payslip PDF route would just work. Precedent: commerce portal `GET /invoices/:id/pdf` (`apps/workers/commerce-api/src/routes/public-commerce-portal/index.ts:626`) |
| Crons | None. `hr-api/wrangler.toml` has no `[triggers]`, and `src/index.ts` exports only `fetch` | Pay-run reminders, filing deadlines and period locks need a scheduled handler |
| Bindings | `WORKSPACE_CACHE`, `ENTITY_EVENTS`, `REALTIME`, `SEND_EMAIL`, `FLAGSHIP` | No R2 (payslip storage), no `BOOKS_API` binding |
| Permissions | `employees:*` incl. `sensitive` and `self`, `attendance:*+approve`, `leave:*+approve` (`packages/core/permissions/src/catalog.ts:432-460`); ADMIN all, MEMBER/VIEWER none; `EMPLOYEE_MEMBER_PERMISSIONS` (l.704) | No `payroll:*` object. Running and approving payroll should be separate from reading sensitive data |
| Entity events | `hr_employee`, `hr_attendance`, `hr_leave_request`, … (`packages/core/entity-events/src/events/hr.ts:10-18`); payloads are ids and status only | Pay runs need events for workflows (e.g. "pay run approved"). Amounts should stay off the bus, as WeldPass does for secrets |
| Audit | `hr_audit_events` via `recordHrAudit` (`services/weldhr/shared.ts:120`) | Add pay-run approval, payslip views, bank-detail changes (a classic payroll-fraud vector) |
| Gating | Installation only (`useAppAccess('weldhr')`, `apps/web/platform/app/weldhr/layout.tsx:16`); no feature flag | A payroll flag per country during the build |

The original module plan (`.claude/weldhr-plan.md`, phase 3) lists "payroll
integration" as a later item. The module came from a BPO prospect, which is
why client assignments are its spine.

## 2. Hours outside WeldHR

WeldFlow `time_entries` (`packages/core/db/src/schema/time-entries.ts`) carry
`userId` (Clerk), `projectId`, `duration`, `billable`, `rate`, `cost` and an
approval status that includes `billed`, served by
`apps/workers/flow-api/src/routes/time-entries/`. They don't link to
`hr_employees` (the only join is `hr_employees.user_id`), and nothing ever sets
`billed`.

**Implication:** for payroll, HR attendance should be the source of truth for
paid hours. WeldFlow time is project and billing time for knowledge workers.
For staffing, client billing should read the same approved attendance rows
that payroll reads, so pay and bill can't drift apart.

## 3. WeldBooks

- **Posting core:** `apps/workers/books-api/src/services/accounting-posting.ts`
  - `postJournalEntry` (l.163) checks balance, fiscal periods and lock dates,
    and is idempotent on `postingKey` (a pay-run id fits). It takes a free
    `sourceType`/`sourceId`.
  - Also `reverseJournalEntry` (l.307), `loadEntityAccounts` (l.518) and
    `accountForRole` (l.533).
- **Not reachable from other workers:**
  - The public route `POST /api/journal-entries` hard-codes
    `sourceType: 'manual'` (l.169) and creates drafts.
  - books-api has no `WorkerEntrypoint`. Precedents elsewhere:
    `AppApiInternal` (`app-api/src/index.ts:306`), `ConnectInternal`
    (`connect-api/src/index.ts:115`), `CallInternal`.
  - external-api treats journals and invoices as read-only.
- **No payroll account roles:**
  - `SystemAccountRole` (`packages/domains/books/src/jurisdictions/types.ts:18`)
    has none. Needed: gross wages, employer social charges, wage tax payable,
    social security payable, pension payable, net pay clearing, holiday pay
    accrual.
  - The NL chart has `1800`, `4100`, `4110` and `4120`, but no `systemRole`.
  - There is no US adapter yet (registry has `NL`, `IN`).
- **Entities:** a workspace can have several accounting `entities`, each with
  a `jurisdictionCode` (`packages/core/db/src/schema/accounting-entities.ts`;
  resolved in `books-api/src/lib/entity-context.ts:13`). This is the natural
  "legal employer" for an employee.
- **No dimensions:** journal lines have no department or cost-centre
  dimension. Staffing customers want wage cost per client, and departments
  want cost per department.

The journal shape per pay run is already described in
`docs/plans/weldbooks-us-research/federal.md` §8, with Gusto's General Ledger
API as the import route.

## 4. Paying people

- Neither SEPA pain.001 nor Nacha is generated anywhere. There is no
  payment-batch model.
- `bank_accounts` (`accounting-bank-accounts.ts`) holds IBAN and BIC; there
  is no routing number.
- `payments.paymentMethod` lists `ach` and `bank_transfer`
  (`accounting-payments.ts:27`).
- Bank import parsers exist (`services/bank-parsers/{camt053,mt940,csv}.ts`),
  so a salary batch could be matched back on the statement.
- Nacha and checks are later phases of `docs/plans/weldbooks-us.md`.

## 5. Payslip documents

- Server side there is printable HTML only (`generateInvoiceHtml`,
  `packages/domains/books/src/accounting-invoice-html.ts`, which notes Workers
  have no PDF library).
- Real PDFs are made in the browser with `pdf-lib`
  (`apps/web/platform/lib/weldbooks/invoice-pdf.ts`). It is a pure function
  and can move to a Worker.
- Generated PDFs are not stored. books-api's `STORAGE` R2 bucket holds
  attachments only.

**Implication:** payslips (and the NL jaaropgaaf / US W-2 copies) need a
server-side renderer and an R2 bucket on hr-api. Payslips are immutable
records with a retention duty (7 years in NL), so they should be stored, not
re-rendered.

## 6. Provider connections

- WeldConnect's connector framework:
  - `connector_connections` (`packages/core/db/src/schema/connector-connections.ts`):
    `provider`, encrypted `credentials`, `enabledSyncs`, `syncWatermarks`,
    `webhookSecret`, `webhookRegistrations`, plus `connectorSyncRuns`.
  - Catalog: `packages/core/connectors/src/catalog.ts`, with
    `auth: api_key|app_auth|oauth2` and `delivery: webhook|poll|hybrid`.
    Today it has woocommerce, shopify, moneybird and picqer.
  - Domain code: `packages/domains/connect/src/connectors/`.
- Webhooks arrive at `integration-webhook-worker`
  `POST /webhooks/connectors/:connectionId`. Polling runs on
  `integration-sync-worker`'s 15-minute cron over the `CONNECT_INTERNAL`
  binding.

**Implication:** a Nmbrs, Loket, Gusto or Check connector fits this framework
(credentials, webhooks, catch-up polling, sync audit). `ConnectorEntity` needs
employee, pay-run and payslip entities. An embedded provider (approach B) is
deeper than a connector, because the provider becomes the system of record for
pay. It may still reuse the credential storage and webhook ingestion.

## 7. Billing

- Plans have `priceMonthly`, `pricePerUser`, `includedUsers`,
  `monthlyCredits` and `features` (`packages/core/db/src/schema/plans.ts`).
  Seats come from `workspaces.purchasedSeats`.
- `workspace_members.memberType = 'EMPLOYEE'` is a paid seat for employees
  using My HR and WeldChat (`schema/workspace-members.ts:51`). It is the only
  HR-linked charge.
- Credits (`packages/core/credits/src/index.ts`, `SERVICE_CREDIT_RATES` l.69)
  meter AI, labels, VoIP, meetings and social. There is no per-payslip unit.
- First-party modules have no per-module price. billing-worker's
  `app-subscriptions` covers user-created WeldApps only. WeldHR is free to
  install (`apps/web/admin/lib/apps-seed-data.ts:603`).

**Implication:** payroll as a revenue line needs a Stripe price "per paid
employee per month", metered from completed pay runs. Credits are a poor fit:
payroll is a predictable monthly charge, and customers compare it with
per-payslip prices from Nmbrs, Loket or Gusto. This work is the same for A, B
and C.

## 8. Mobile

There is no HR mobile app (`apps/mobile/` has no weldhr). Payslips reach
employees through the web portal and the platform's My HR page.

## 9. Foundations every approach needs

These come before, or alongside, any of A, B or C:

1. **Legal employer:** link employees to a WeldBooks `entities` row (country,
   currency, employer tax ids: NL loonheffingennummer, US EIN and state
   accounts).
2. **Effective-dated compensation:** a `hr_compensations` history (base
   amount, period, hours/FTE, currency, pay schedule, effective from/to).
   Payroll reads the value in force for the period instead of the current
   blob value. Keep the amounts in plain columns behind `payroll:*`
   permissions, and keep only identifiers and bank details encrypted.
   Field-encrypted amounts would block sums, variance checks and reports.
3. **Pay calendar:** pay schedules (NL monthly or 4-weekly; US weekly,
   biweekly, semimonthly or monthly), pay periods with a lock, and public
   holidays per country.
4. **Pay inputs ("mutaties"):** approved hours by pay code from attendance,
   leave by type with paid percentage, one-off earnings and deductions
   (bonus, allowance, expense reimbursement, advance), with an approval step.
   This is the whole of approach A, and B and C consume it.
5. **Pay runs and payslips:** draft → review (variance against last period) →
   approved → submitted/paid. Snapshot each payslip's lines on approval, and
   correct through a new run, never by editing.
6. **Books bridge:** a `BooksInternal` entrypoint exposing `postJournalEntry`
   with `sourceType: 'payroll'`, payroll `SystemAccountRole`s in the NL and US
   charts, and a department/client dimension on journal lines.
7. **Billing:** a per-paid-employee price.

Staffing adds rate cards on assignments, client timesheet approval in the
existing client portal, and invoices from approved hours (see
[staffing.md](staffing.md)).
