# Custom fields: blob extraction plan (Phase 4, revised)

Companion to [custom-fields-values-table.md](./custom-fields-values-table.md).

## Why this document exists

Phase 4 of the original plan was "drop the 16 `custom_fields` jsonb columns".
That plan rested on an assumption that turned out to be false:

> the other 10 tables ... do not accept `customFields` on their create/update
> API today, so there is nothing to mirror

"The API doesn't accept it" is not the same as "the column is empty". A
code sweep plus a live data audit (`pnpm audit:blobs`) found **7 of the 16
tables carry non-definition data** written by product features, not by users.

Dropping those columns would have destroyed all of it. None of it was migrated
by the Phase 2 backfill, which only migrates keys that match an active
`custom_field_definitions.slug`.

### How the two methods disagreed, run both

Neither audit alone was sufficient:

- `calendar_events`, static analysis found **no reader and no writer** anywhere
  in the monorepo, yet the data holds `sourceType` / `sourceId` /
  `autoScheduled` / `reason` / `taskPriority`. Written by the `api-worker` that
  was deleted 2026-07-17. **Code sweep alone would have dropped it.**
- `helpdesk_tickets`, **no rows** in the audited environment, yet the code shows
  every WeldDesk ticket-type dynamic form value lands there. **Data audit alone
  would have dropped it.**

Always run `pnpm audit:blobs` against the target environment AND re-sweep the
code before dropping anything.

## Governing principle

> `custom_field_values` is for **user-created** fields only. Anything that is a
> product feature gets a **real database column**.

This splits the offending keys into two piles with different fixes.

## Pile A, default fields → real columns

Product features that were using the blob as an extension bag.

| table | keys | becomes |
| ----- | ---- | ------- |
| `tasks` | `attachments` | relation to `files` (see note) |
| `crm_activities` | `fileKey`, `fileName`, `fileSize`, `contentType`, `etag` | relation to `files` (see note) |
| `crm_activities` | `labels`, `assigneeIds`, `repeat` | real columns |
| `crm_activities` | `changes`, `__changeLog`, `changedFields`, `previousValues`, `newValues` | real column (read-only legacy; writer was the deleted `api-worker`) |
| `mail_messages` | `snoozedUntil`, `snoozedAt`, `unsnoozedAt`, `unsnoozedEarly`, `resnoozedAt`, `unsnoozeTriggerRunId` | real columns |
| `mail_messages` | `sendStatus`, `sendProvider`, `providerMessageId`, `scheduledFor`, `mailgunMessageId` | real columns |
| `calendar_events` | `sourceType`, `sourceId`, `autoScheduled`, `reason`, `taskPriority` | real columns |

**DECIDED, attachments relate to `files`, and this needs NO schema change.**
`files` already carries `entityType` / `entityId` with an index
(`files_entity_idx`, `packages/core/db/src/schema/files.ts:58`). Task and
activity attachments become ordinary `files` rows with
`entityType='task'|'crm_activity'` and `entityId=<row id>`. That drops the
duplicated storage metadata (`fileKey`/`fileName`/`fileSize`/`contentType`/
`etag`) entirely and makes attachments visible to the existing file surfaces.
Migration is a data move, not a schema change.

## Pile B, a second user-defined field system → fold into `custom_field_values`

These are **not** default fields. They are user-authored fields that happen to
use a different authoring UI, so per the governing principle they belong in the
same value store as custom fields.

| table | what | authored in |
| ----- | ---- | ----------- |
| `helpdesk_tickets` | ticket-type dynamic form fields, keyed by `helpdesk_ticket_types.fields[].key` | `app/welddesk/settings/ticket-types/ticket-type-editor.tsx` |
| `helpdesk_conversations` | arbitrary attribute names from the `set_conversation_attribute` workflow step | WeldDesk workflow editor |
| `people` | arbitrary attribute names from the `set_contact_attribute` workflow step (those not in `DIRECT_FIELDS`) | WeldDesk workflow editor |

Resolved design decisions for Pile B:

1. **Ticket-type scoping, DECIDED: nullable `ticketTypeId` on
   `custom_field_definitions`.** A definition scoped to one ticket type, or
   `null` meaning "all tickets". Faithful to how ticket types actually work, and
   survives a ticket-type rename (unlike the `group`-as-convention alternative).
   ⚠️ The existing `uniqueIndex(entityType, slug)` must become
   `(entityType, slug, ticketTypeId)` **with `NULLS NOT DISTINCT`**, Postgres
   treats NULLs as distinct by default, so a plain 3-column unique index would
   silently allow duplicate global (entityType, slug) pairs and lose the
   guarantee that exists today.
2. **Workflow attributes, DECIDED: pick from existing definitions.** The
   `set_contact_attribute` / `set_conversation_attribute` steps change from a
   free-text name to a picker over existing definitions for that entity type.
   Prevents definition spam and gives every attribute a real `fieldType`.
   Requires: workflow editor UI change, plus a migration pass over saved
   workflows whose steps carry free-text attribute names (either map them to a
   matching definition or create one during migration, then flag for review).
3. The helpdesk widget writes ticket-type values too
   (`apps/workers/helpdesk-widget-api/src/routes/tickets.ts:243`), an
   unauthenticated surface. Whatever storage it targets must be reachable from
   that worker.

## Sequencing

Landing as one change on `claude/custom-fields-blob-extraction`, built as a
stack of individually-verified commits:

1. **Hydrate merge fix**, `hydrateCustomFields` merges instead of replacing, so
   non-definition keys survive the Phase 3 read cutover. This is a LIVE data-loss
   fix; it is first so it can be cherry-picked ahead of the rest if needed.
2. **Audit tooling**, `pnpm audit:blobs`, plus a production-capable workflow.
3. **Pile A schema**, new columns / relations, no behaviour change.
4. **Pile A data migration**, blob → columns, verified per tenant.
5. **Pile A code cutover**, read/write the new columns; stop touching the blob.
6. **Pile B**, definitions model change, then migrate ticket-type + workflow
   attribute values into `custom_field_values`.
7. **Phase 4 drop**, remove `customFields` from all 16 schema files, remove the
   dual-write and the hydrate blob fallback, generate the Drizzle migration.

Step 7 is irreversible and auto-applies on merge (`deploy.yml` triggers the
migration job on any change under `packages/core/db/**`). Do not merge until
`pnpm audit:blobs` reports zero unmapped keys **in production**.

## Preconditions for step 7

- [ ] `pnpm audit:blobs` against **production** reports zero unmapped keys
- [ ] Steps 3–6 deployed and verified in production
- [ ] Hydrate blob fallback removed (`custom-field-values.ts`)
- [ ] Dual-write `syncValuesForEntity` promoted from best-effort mirror to the
      authoritative write, it currently swallows errors, which is correct for a
      mirror and wrong for a primary store
- [ ] No code writes `customFields:` to any of the 16 tables
