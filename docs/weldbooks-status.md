# WeldBooks — Implementation Status

Status snapshot of the WeldBooks (accounting) module across platform UI, `app-api`, schema, and mobile.

| | |
|---|---|
| **Module** | WeldBooks (`/weldbooks`) |
| **Stack** | Platform SPA → `app-api` → Neon tenant DB (Drizzle) |
| **Overall maturity** | Core double-entry ops are production-wired; configuration, automation, live filing, and multi-country compliance are incomplete |
| **Rough completeness** | ~70% of day-to-day ledger workflows · ~40% of a full commercial accounting product |

---

## Maturity legend

| Label | Meaning |
|-------|---------|
| **Done** | UI + client + API + schema wired; usable in production for that feature |
| **Partial** | Substantial code exists, but stubbed, simulated, missing UI, or not end-to-end |
| **Missing** | Expected for a full product; little or no product surface |

---

## 1. Fully implemented (Done)

These are production-wired end-to-end unless noted.

### Platform shell & multi-entity

| Feature | Notes |
|---------|--------|
| App gate + `/weldbooks` layout | `useAppAccess('weldbooks')` |
| Module sidebar | Dashboard, sales, purchases, banking, ledger, contacts, reports, settings |
| Entity switcher | Jotai + `X-Accounting-Entity-Id` on all WeldBooks API calls |
| Accounting entities — list / add | Jurisdiction seed defaults on create |
| NL KOR toggle | Per-entity |

### Dashboard

| Feature | Notes |
|---------|--------|
| KPI dashboard | Revenue, expenses, AR/AP, bank balances, payments, overdue |

### Sales (AR)

| Feature | Notes |
|---------|--------|
| Invoices — list / create / edit / detail | Edit restricted to drafts server-side |
| Invoice finalize | Posts journal entry; reverse-charge VIES check on finalize |
| Record payment (from invoice) | Writes payment + updates invoice balances |
| Invoice PDF download | Client-side `pdf-lib` generation |
| Credit notes — list | Filters invoices with `type=credit_note` |
| Recurring — list / detail | — |
| Recurring — pause / resume / manual generate | Create UI is not Done (see Partial) |

### Purchases (AP)

| Feature | Notes |
|---------|--------|
| Bills — list / create / edit / detail | — |
| Bill approve / reject | Reject with reason |
| Documents inbox — upload / list / stats / reject | — |
| Rematch supplier / create bill from document | Metadata path works; OCR extraction itself is Partial |

### Banking

| Feature | Notes |
|---------|--------|
| Bank accounts — CRUD | — |
| Bank transactions — list / filter | — |
| Statement import | CSV, MT940, CAMT.053 |
| Reconciliation | Match, suggestions, auto-reconcile, exclude |
| Reconciliation rules — CRUD | — |

### Ledger

| Feature | Notes |
|---------|--------|
| Chart of accounts — list / create / detail / edit | Delete API exists; no delete UI |
| Journal entries — list / create / detail / post | Balanced create; post draft → posted |

### Tax (calculate & export)

| Feature | Notes |
|---------|--------|
| VAT returns — calculate / list / detail | Rubrieken from ledger |
| VAT return XML download | — |
| Suppletie (correction record) | Creates correction return record |
| ICP declarations — calculate / list | — |

### Contacts

| Feature | Notes |
|---------|--------|
| Customers — list / create / detail / edit | No delete UI |
| Suppliers — list | Same contacts API, `role=supplier`; create via customer flow |

### Reports

| Feature | Notes |
|---------|--------|
| Profit & loss | — |
| Balance sheet | — |
| Trial balance | — |
| Aged receivables | — |
| Aged payables | — |
| Cash flow | Page exists; not in sidebar |
| General ledger | Per-account; not in sidebar |

### Settings / exports

| Feature | Notes |
|---------|--------|
| Document email inbox registration | — |
| Seed accounting workflow templates | — |
| XAF audit file export | By fiscal year |

### Backend foundation (no dedicated platform page required)

| Feature | Notes |
|---------|--------|
| ~20+ accounting schemas | Entities, CoA, JE, invoices, bills, payments, banking, tax, VAT, ICP, fiscal periods, FX, audit log, etc. |
| Closed-period guards | Enforced in services when periods exist |
| Payments API | Used via invoice `record-payment`; general `/payments` exists |
| Tax rates API | CRUD; consumed as selectors on invoice/bill forms |
| Fiscal periods API | Close/reopen; **no platform UI** |
| FX rate lookup API | Under accounting-settings; **no admin UI** |

---

## 2. Partial

Substantial work exists, but not ready to treat as a complete production feature.

| Feature | How far | What’s missing |
|---------|---------|----------------|
| **Invoice “Send”** | ~40% | UI + API set `status=sent` / `sentAt` only — **no email delivery** |
| **Credit note from invoice** | ~70% | `POST /invoices/:id/credit-note` + client exist; **no UI button** |
| **Recurring invoice create** | ~50% | API create exists; `/recurring/add` is explicit **coming soon** stub |
| **Recurring automation** | ~30% | Manual generate works; scheduled/idempotent job (Trigger.dev in docs) **not present** |
| **Documents / OCR** | ~45% | Upload + workflow UI work; OCR service is **stubbed** (empty/null fields) |
| **VAT / ICP filing (Digipoort)** | ~55% | Calculate + XML + file UI work; Digipoort defaults to **`simulated`** (fake kenmerk unless cert + production mode) |
| **Settings — company & numbering** | ~25% | Form shows values; Save buttons have **no handlers** / no `updateSettings` |
| **Journal reverse** | ~60% | `POST …/reverse` exists; detail UI only posts drafts |
| **Bill payments** | ~40% | Payments API supports `billId`; **no bill “record payment” UI** |
| **Payments register** | ~35% | `listPayments` / payments API exist; **no `/weldbooks/payments` page** |
| **Multi-currency display** | ~40% | Entities can set base currency; most reports/dashboard formatters **hardcode EUR** |
| **FX rates** | ~35% | Table + exchange-rate API; **no FX admin UI** |
| **Tax rate admin** | ~40% | Full `/tax-rates` CRUD API; UI only selects rates on forms |
| **Fiscal periods** | ~50% | Full `/fiscal-periods` API (close/reopen); **zero platform routes/client methods** |
| **Account / customer delete** | ~50% | Delete APIs exist; **no delete UI** |
| **Entities edit / delete** | ~40% | Add + KOR; no full edit/delete surface |
| **CRM → accounting contacts import** | ~10% | Route exists as **no-op stub** |
| **Server invoice PDF** | ~50% | `GET /invoices/:id/pdf` exists; UI uses client pdf-lib instead |
| **Mobile `weldbooks-app`** | ~55% | Invoices, scan, expenses, bank, recon, VAT, P&L/BS, offline queue — thinner than web (no full CoA/journal/entities/recurring parity) |

---

## 3. Not implemented (Missing)

Expected for a full working commercial accounting product; little or no product surface today.

### Product / ops gaps

| Feature | Status |
|---------|--------|
| Live open-banking / continuous bank sync | Missing (file import only) |
| Automated recurring invoice scheduler | Missing (manual generate only) |
| Working settings persistence (company + numbering) | Missing (UI shell only) |
| Fiscal period close/reopen in platform | Missing UI |
| Tax rate management pages | Missing UI |
| FX rate admin + multi-currency UX throughout | Missing |
| Payments register page | Missing |
| Bill payment UX | Missing |
| Journal reverse UX | Missing |
| Recurring create form | Explicit coming soon |
| VIES check admin UI | Missing (finalize-path only) |
| Budgeting | Missing |
| Fixed assets | Missing |
| Payroll | Missing |
| Inventory valuation / stock link | Missing |
| Multi-book consolidations | Missing |
| Sidebar links for cash flow / GL / reports hub | Incomplete nav |

### Country compliance / e-invoicing

Country agents (`accounting-nl`, `-be`, `-de`, `-fr`, `-uk`, `-us`) describe formats; most are **not productized**.

| Capability | Status |
|------------|--------|
| Digipoort production filing (NL) | Partial — simulated by default |
| Intervat (BE) | Missing as live product |
| ELSTER (DE) | Missing as live product |
| HMRC (UK) | Missing as live product |
| Peppol e-invoicing | Missing |
| Factur-X / XRechnung | Missing |
| US sales-tax workflows | Missing (WeldBooks is VAT-oriented) |

---

## 4. How far is it? (summary)

```
Day-to-day bookkeeping (invoices, bills, CoA, journals, bank import/recon, core reports)
████████████████████░░░░  ~70%

Configuration & period control (settings save, fiscal periods, tax/FX admin)
████████░░░░░░░░░░░░░░░░  ~35%

Automation (recurring schedule, open banking, OCR that extracts)
██████░░░░░░░░░░░░░░░░░░  ~25%

Live tax filing & e-invoicing (Digipoort prod, Peppol, other countries)
████░░░░░░░░░░░░░░░░░░░░  ~15–20%

Full commercial accounting suite (assets, payroll, budgets, consolidations)
███░░░░░░░░░░░░░░░░░░░░░  ~10–15%
```

**Practical takeaway:** A workspace can run core AR/AP, double-entry journals, file-based bank reconciliation, NL-oriented VAT *calculation*, and standard financial reports in the platform today. It is **not** yet a complete accounting product for live government filing, automated recurring billing, multi-currency ops, or open banking.

---

## 5. Code map

| Layer | Location |
|-------|----------|
| Platform UI | `apps/web/platform/app/weldbooks/` |
| Routes | `apps/web/platform/src/routes/weldbooks/` |
| API client | `apps/web/platform/lib/api/domains/weldbooks.ts` |
| Query hooks | `apps/web/platform/hooks/queries/use-accounting-queries.ts` |
| Sidebar | `apps/web/platform/components/layout/module-sidebar-configs.tsx` (`weldbooks`) |
| Backend | `apps/workers/app-api/src/routes/` + `services/accounting-*.ts` |
| Schema | `packages/core/db/src/schema/accounting-*.ts` |
| Mobile | `apps/mobile/weldbooks-app/` |
| Domain agent notes | `.claude/agents/weldbooks-accounting.md` (partially stale: still mentions deleted `api-worker` / Trigger.dev) |
| E2E | `apps/web/platform/e2e/specs/weldbooks/` |

### Main API mounts (`app-api`)

`/api/accounting-dashboard`, `/accounting-settings`, `/accounting-entities`, `/accounting-contacts`, `/accounting-documents`, `/accounting-reports`, `/accounting-exports`, `/gl-accounts`, `/invoices`, `/bills`, `/journal-entries`, `/payments`, `/bank-accounts`, `/bank-transactions`, `/reconciliation-rules`, `/recurring-invoices`, `/tax-rates`, `/vat-returns`, `/icp-declarations`, `/fiscal-periods`

---

## 6. Suggested next priorities

Highest leverage to close the “full working account” gap:

1. Wire settings Save (company details + numbering) to `updateSettings`
2. Recurring create form (API already exists)
3. Fiscal period UI (API already exists)
4. Tax rate + FX admin pages
5. Bill payment UI + payments register
6. Real OCR (or remove stubbed process UX)
7. Digipoort production path (certs + non-simulated mode) for NL
8. Stop EUR-hardcoding; respect entity base currency
9. Invoice send → real email delivery
10. Credit-note create button on invoice detail

---

*Generated from codebase review of platform + `app-api` + schema. Percentages are engineering judgment, not formal metrics.*
