# Companies + People Refactor, Pending Cleanup

This document describes work that's intentionally **deferred** out of the
Companies + People refactor branch (`refactor/companies-people`). The refactor
itself is complete and shippable in its current state, both code paths (new
Companies/People surfaces and the legacy customers/contacts surfaces) work
side-by-side via dual-write at the service layer.

The deferred work is the **removal** of the legacy code path. It's blocked on
a few coordinated changes that are too risky to bundle into the initial
merge.

## What's deferred and why

### 1. Rewrite legacy api-worker routes (`apps/api-worker/src/routes/`)

**Scope**: ~3,900 LOC across 7 route files:

- `crm/customers.ts` (1,420 LOC)
- `crm/contacts.ts` (645 LOC)
- `crm/contact-links.ts` (472 LOC)
- `helpdesk/contacts.ts` (435 LOC)
- `commerce/customers.ts` (475 LOC)
- `accounting/contacts.ts` (324 LOC)
- `mail/contacts.ts` (168 LOC)

**Why deferred**: each route reads/writes legacy `parties` columns
(`companyName`, `firstName`, `lastName`, `email`, `phone`, `type`, etc.). If
we drop those columns, every route breaks. To drop them, every route must
first be rewritten to read from `companies`/`people` and to dual-write
through `parties` (the wrapper).

**What unblocks dropping legacy DB columns**: this work plus the mobile
follow-up plan (mobile apps still call these routes and read those response
shapes).

### 2. Rename 35 cross-module screens (workstream 5 of Phase 9)

**Scope**: 35 platform files referencing `customerId` / `contactId`:

- weldbooks: `banking/rules`, `bills/bill-form`, `invoices/invoice-dialog`,
  `invoices/invoice-form`, `recurring/[id]`
- weldcommerce: 10 files (orders, discounts, customer detail)
- welddesk: 9 files (customers, inbox, conversation detail)
- weldmail: 2 files (customer-detail-panel, message-detail)
- weldmeet: 3 files (attendees, guest-create dialog, meeting overlay)
- weldflow: 2 files
- weldchat: 2 files
- weldcalendar: 1 file
- weldconnect: 1 file

**Why deferred**: the `customerId` / `contactId` references aren't just
TypeScript variables, they're JSON keys in API request payloads sent to
the legacy api-worker. Renaming them without coordinating Phase 5 above
would break API contracts (the worker still expects `{ customerId: x }`).

**Mitigation in place**: the `ensureWrappingParty()` dual-write in
`apps/core-api/src/services/companies.ts` and `services/people.ts` keeps
`parties.companyName` / `parties.firstName` / etc. populated whenever a
Company or Person is created or updated via the new pages. So existing
legacy pickers and forms (invoice form, order form, helpdesk customer
selector, etc.) work correctly against entities created on either side.

### 3. Delete legacy platform folders

**Scope**:

- `apps/web/platform/app/weldcrm/customers/` (~60 files, except `redirect-page.tsx` files)
- `apps/web/platform/app/weldcrm/contacts/` (~20 files, except `redirect-page.tsx` files)
- `apps/web/platform/components/objects/customer/`
- `apps/web/platform/components/objects/contact/`
- `apps/web/platform/components/customer-detail/`
- `apps/web/platform/hooks/queries/use-customers-queries.ts`
- `apps/web/platform/hooks/queries/use-contacts-queries.ts`
- `apps/web/platform/hooks/queries/use-customer-lists-queries.ts`

**Why deferred**: 37 files outside these folders still import from them.
Notable external consumers:

- `app/weldmeet/contacts/page.tsx`
- `app/welddesk/inbox/all/[conversationId]/conversation-detail-client.tsx`
- `app/weldmail/components/customer-detail-panel.tsx`
- `app/weldchat/components/entity-detail-panel.tsx`
- `components/team-member-details-panel.tsx`
- `components/weldcrm/calls/join-meeting-bot-dialog.tsx`
- `components/entity-sheet/registry.tsx`
- `app/settings/weldcrm/customer-statuses/page.tsx`

Each of those must be migrated to the new Companies/People surfaces before
the legacy folders can safely be removed.

### 4. Drop legacy DB columns and tables

**Scope**, generate and apply a Drizzle migration that:

- Drops legacy columns from `parties`: `firstName`, `lastName`, `fullName`,
  `companyName`, `tradingName`, `email`, `phone`, `mobile`, `fax`,
  `industry`, `website`, `vatNumber`, `registrationNumber`, `type`,
  `primaryContactId`, `parentPartyId`, `segment`, `rating`, `source`,
  `ownerId`, `accountManagerId`, `status`, `lifecycleStage`,
  `firstContactDate`, `lastContactDate`, `nextFollowUpDate`, `avatarUrl`,
  `linkedinUrl`, `twitterHandle`, `facebookUrl`, `isFavorite`,
  `dateOfBirth`, `gender`, `employeeCount`, `annualRevenue`, `tags`,
  `customFields`, `notes`, `internalNotes`, ... (~40 columns)
- Drops legacy tables: `contacts`, `contact_customers`, `contact_suppliers`,
  `accounting_contacts`, `customer_lists`, `customer_list_members`,
  `contact_list_members`
- Renames `contact_external_identities` → `person_external_identities`

**Why deferred**: depends on items 1, 2, and 3 above. Also depends on the
**mobile follow-up plan**, mobile apps still read these columns through the
legacy api-worker routes. The drop must come after mobile has migrated.

### 5. Object panel barrel, remove legacy registrations

After 3 above:

```diff
// components/objects/index.ts
-import './customer';
-import './contact';
 import './company';
 import './person';
 import './team-member';
 import './task';
```

### 6. Permission catalog, remove legacy entries

After 1 above:

- Remove `customers` and `contacts` permission objects from
  `packages/core/permissions/src/catalog.ts`
- Remove `customers:scope:all` / `contacts:scope:all` from
  `LEGACY_ADMIN_PERMISSIONS`
- Remove `weldcrm:contacts:*` and `weldcommerce:customers:*` from
  `LEGACY_MEMBER_PERMISSIONS`

### 7. i18n, keep or remove legacy `customers` namespace

`packages/core/i18n/src/locales/{en,nl,fr}/customers.ts` can stay as long as
anything still calls `t.customers.title`. Once `customer-detail/` is removed
(item 3), remove the customers locale namespace too.

## Sequencing for the follow-up release

```
1. Rewrite legacy api-worker routes (item 1), ~6–8h
   ↓
2. Coordinate with mobile team to migrate off
   legacy /crm/customers + /crm/contacts shapes, separate plan
   ↓
3. Rename 35 cross-module screens (item 2), ~4–6h
   ↓
4. Migrate the 8 external consumers of customer/
   contact panels (item 3, sub-list), ~3h
   ↓
5. Delete legacy folders (item 3), ~1h
   ↓
6. Drop legacy DB columns + tables (item 4), ~1h
   ↓
7. Update barrels and catalogs (items 5, 6, 7), ~30min
   ↓
8. Final lint + type-check + build + Playwright, ~1h
```

Total: ~16–20 hours of focused work, plus the mobile coordination.

## What's safe to do immediately

Without coordinating any of the above, these are safe right now:

- **Object panel registration cleanup**: when a user lands on
  `/weldcrm/companies` or `/weldcrm/people` and clicks a row, the new
  Company/Person panel opens. The legacy customer/contact panels still
  register too (since 37 external files import them), they're idle but
  loaded. That's the current state and is correct.
- **Sidebar entries**: "Companies" + "People" present; "Customers" +
  "Contacts" removed. Already done.
- **Legacy URL redirects**: `/weldcrm/customers` → `/weldcrm/companies?filter=customers`;
  `/weldcrm/customers/:id` → resolved to companies/:id or people/:id via
  parties lookup. Already done.

## Verification snapshot at refactor branch tip

Type-check results across changed workspaces (errors caused by my refactor
vs pre-existing):

| Package | My errors | Pre-existing |
|---|---:|---:|
| `packages/core/db` | 0 | 73 |
| `packages/clients/core-api-client` | 0 | 0 |
| `packages/core/permissions` | 0 | 0 |
| `packages/core/i18n` | 0 | 0 |
| `apps/core-api` | 0 | 59 |
| `apps/web/platform` | 0 | 0 |
| `apps/tools/migrate-databases` | 0 | 0 |

Playwright spec added: `apps/web/platform/e2e/specs/weldcrm-companies-people.spec.ts`
,  covers list rendering, displayName-only render, quick-add, detail navigation,
sidebar nav, lists pages, and legacy URL redirects.
