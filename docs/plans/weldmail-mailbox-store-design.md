# WeldMail mailbox store: implementation design (phases 3–6)

Working design for `docs/plans/weldmail-mailbox-storage.md` phases 3–6, all in
one PR with the `weldmail-mailbox-store` flag defaulting to `postgres`.

## Decisions on top of the design below (2026-10-28, binding)

These override the design where they differ.

1. **The mail index is an EU object, not the OutboundLedger.** Correspondents
   and the address index (§3.9) hold email addresses, so they live in a
   per-workspace object in the EU jurisdiction, like the mailboxes (ADR
   MAIL-009). Host it as its own SQLite Durable Object class `MailIndex` in
   mail-api, reached through `env.MAIL_INDEX.jurisdiction('eu')`, name
   `mbxidx:<workspaces.id>`, with the RPC surface §3.9 gives the ledger
   (`recordMailAddresses`, `firstContacts`, `mailboxesForAddress`,
   `ensureCorrespondentsSeeded`, `dropMailbox`, `forgetMailData`). The
   OutboundLedger keeps its counters only; `checkOutbound` calls `MailIndex`
   for first contacts. Same `new_sqlite_classes` migration as `MailboxStore`.
2. **Permission cache TTL** becomes long-lived with version invalidation (set in
   the permission-cache work, not here). Assume `requirePermission` is served
   from KV on a cold open.
3. **Search.** Two FTS5 tables per mailbox: `messages_fts_meta` with
   `tokenize='trigram'` over subject, from and to/cc addresses and names, so
   substring search keeps working there; `messages_fts_body` with
   `unicode61 remove_diacritics 2`, `detail=column`, contentless, over the first
   8 KB of body text (token-prefix matching). Search excluded from parity.
4. **Phase 2 columns.** No `body_key` / `search_text` columns: bodies and raw
   MIME live at deterministic R2 keys
   `mail/<workspaceId>/<accountId>/<messageId>/{body.html,body.txt,raw.eml}`.
   Phase 2's migration is only the two `mail_messages` indexes.
5. **Existing access bugs listed in "Where the plan or ADR is wrong" item 9 are
   fixed in this PR**, in the task that touches the code, each with a test.
6. **Consumer WeldMail** (personal-api, personal DB) stays out of scope.
7. **Bodies and raw MIME go to a new EU bucket** (owner, 2026-10-28):
   `weldsuite-mail` / `weldsuite-mail-test`, created with `--jurisdiction eu`,
   bound as `MAIL_STORAGE` (`jurisdiction = "eu"` on the `[[r2_buckets]]`
   binding) in every worker that reads or writes them. Not the existing
   `STORAGE` bucket, which is not EU-pinned. Attachments stay in `STORAGE` for
   now. The buckets must exist before the PR deploys (ops step).
8. **Mode type.** `MailStoreMode` and the flag name live in `store/types.ts`
   (A3); `store/mode.ts` (A2) and `mail-index/types.ts` (`MailIndexModeHint`)
   use that one type.

---

## 0. Read these first

1. **Phase 1 is being edited in this worktree right now.** These files are modified and uncommitted: `packages/domains/mail/src/{threads,messages,access,snooze}.ts`, the new `db-batch.ts`, `packages/core/worker-kit/src/permission-cache.ts` and `packages/core/db/src/lib/permissions-cache.ts`. Line numbers below are from the current working tree. Tasks B5 and D1–D3 must rebase on that work.
   - The new `ThreadListMessage` type (threads.ts, lean list row without bodies) is the shape the object returns for list rows.
2. **The phase 1 permission cache does not take Neon off the open path.** `PERMISSIONS_CACHE_TTL_SECONDS = 60` (`worker-kit/src/permission-cache.ts`). A user who comes back after 5 idle minutes misses the cache, and `requirePermission` reads the tenant DB, which waits for the compute to wake.
   - Fix: a long TTL (for example 24 h). The `permv:<ws>` version bump already invalidates the cache when permissions change.
   - "No Neon on the mail open path" is not reachable without this fix.
3. **The open path reads more Postgres than the plan lists:**
   - `GET /api/mail-accounts` reads `mail_accounts`;
   - `GET /api/mail-labels` reads `mail_labels`;
   - the stats drafts count reads `mail_drafts` (messages.ts `getMessageStats`, ~line 458);
   - every list reads `people` and `mail_accounts` for sender names (`enrichSenderContacts`, messages.ts:288).

   This design therefore puts account display data and label definitions in the KV mailbox directory, moves drafts into the object, and puts a deadline on sender-name enrichment (§6).
4. **The OutboundLedger is not in the EU jurisdiction.** It is addressed with a plain `idFromName` (guard.ts:281-284, delivery-events.ts:215, ledger key `ws:<id>`). Moving `mail_correspondents` and the new address index there takes personal data (email addresses) outside MAIL-009's "EU from the first object" rule.
   - I designed it as decided, behind a `MailIndex` interface whose host can be swapped.
   - The owner should confirm. The alternative: the same RPC surface on an EU-jurisdiction object `mbx:<ws>:__index`.
5. **R2 residency:** bodies go to the existing `STORAGE` bucket (`weldsuite-storage(-test)`). Check whether it was created with `--jurisdiction eu` before any body is written (pre-flight in task A4).

## 1. Inventory

Classification: **S** = goes through the store; **F** = fan-out read across mailboxes (`WorkspaceMailStore`); **P** = stays on Postgres (config); **L** = moves to the ledger mail index; **X** = drop.

### `packages/domains/mail/src`

| Function (file:line) | Today | Class |
|---|---|---|
| `containsPattern`/`senderMatches`/`anyRecipientMatches`/`messageSearchCondition`/`messageContainsAnyWord` messages.ts:81-138 | ILIKE builders | S (Postgres impl only; the object uses FTS5 + LIKE) |
| `buildMessageConditions` 142, `listMessages` 166 | keyset list, one account or `accessibleAccountIds` | S `listMessages` + F |
| `enrichSenderContacts` 288 | `mail_accounts` + `people` | P. Object modes: own-mailbox names from the directory, contacts with a deadline (§6) |
| `getMessageAccountId` 354 | id → account | F `locateMessages` |
| `getMessage` 363, `getThread` 379 | row + attachments, thread of a message | S |
| `getMessageStats` 458 | 11 aggregates + drafts | S `stats` / F |
| `updateMessage` 513 (+ `labelsForFlagPatch` 560, `leaveLocation` 548) | flag patch with label mirroring | S op `flags` (single semantics). Pure helpers move to `store/model.ts` |
| `softDeleteMessage` 593 | soft delete | S op `delete` |
| `bulkUpdateMessages` 626 | bulk actions | S: compiled to `flags`/`labels.add`/`labels.remove`/`move`/`delete` per mailbox after `locateMessages` |
| `addMessageLabels` 666, `removeMessageLabels` 686 | single add/remove; `canonicalLabelNames` reads `mail_labels` | S ops `labels.add`/`labels.remove` (single). Canonical names: P, served from the directory in object modes |
| threads.ts `resolveAccountScope` 136 | account access | P → `MailAccess` |
| threads.ts `buildExpireScheduledUpdate` 184 | write-on-read: scheduled → sent | X. The workflow is authoritative. Drop from the Postgres path too |
| `threadListScope` 311, `listThreadsByLabel` 373 | conditions (incl. snooze wake) + page | S `listThreads` + F. Access is split out of both |
| `getThreadByKey` 487 | thread by key | S `getThread` |
| `normalizeSubject` 520, `summarizeThreadMessages` 225, `buildThreadSummary` 252 | pure | shared by both stores (`store/model.ts`) |
| `enrichThreadContacts` 531 | `people` | P, as for `enrichSenderContacts` |
| labels.ts pure helpers 23-242 (`addLabels`, `removeLabels`, `flagsForLabelChange`, `normalizeLabel`, `isLocationLabel`, `CLEARED_BY_MOVE`, `OUTGOING_LABELS`) | pure | shared model |
| `inTrashOrSpamCondition`/`archivedCondition`/`labelCondition` 100-142 | SQL | Postgres impl only |
| `resolveCustomLabelNames` 150, `canonicalLabelNames` 174 | `mail_labels` | P (directory in object modes) |
| `withLiveMessageCounts` 283 | GROUP BY over `mail_messages` | S `labelCounts(keys)` |
| `listMailLabels` 312, `getMailLabel` 322 | rows + counts | P rows + S counts |
| `createMailLabel` 354 | row | P + directory version bump |
| `updateMailLabel` 441 | row + relabel messages (`atomically`) | P row + S op `label.rename` |
| `deleteMailLabel` 505 | row + strip label | P row + S op `label.delete` |
| `moveMessagesToLocation` 548 | | S op `move` |
| `bulkAddLabelToMessages` 588, `bulkRemoveLabelFromMessages` 617 | + `updateLabelMessageCount` 688 | S ops (bulk). The `mail_labels.message_count` tally is X: counts come from the store |
| `applyLabelToThread` 662 | | S op `thread.label` |
| snooze.ts `snoozeMessage` 71, `unsnoozeMessage` 98, `resnoozeMessage` 127 | | S ops |
| `buildWakeDueSnoozedUpdate` 160, `wakeDueSnoozedMessages` 193, `nextSnoozeDueAt` 206 | D1 cron + list path | Postgres: op `snooze.wake` (cron). Object: alarm (§3) |
| `listSnoozedMessages` 229 | **all mailboxes, no access filter** | S `listSnoozed` / F, scoped to accessible accounts |
| thread-ops.ts `markThreadRead` 26 | | S op `thread.read` |
| thread-ops.ts `markFolderRead` 84 | | F → per-mailbox op `folder.read` |
| attachments.ts `listAttachmentsForMessage` 61, `getAttachment` 68 | | S |
| `createAttachment` 90, `updateAttachment` 105, `deleteAttachment` 137, `associateAttachments` 170, `refreshMessageAttachmentCount` 190 | | S `attachment.*` ops. `isWorkspaceStorageKey` 49 stays pure and also accepts `mail/<ws>/` |
| drafts.ts (all, 26-146) | `mail_drafts` | S (drafts move into the object, §2) |
| send.ts `findSentByIdempotencyKey` 202 | | S |
| `countSentToday` 260 | | S `countSentSince` |
| `outboundKindOf` 305, `resolveThreadId` 411 | | S `findByRfcIds` |
| `persistSentCopy` 456, `persistAttachmentPointers` 509 | | S op `ingest` (source `sent`) |
| `sentToday` bump (in `sendAndPersist` 597) | | P |
| `loadSendableAccount` 233 | | P / directory |
| `loadOriginalAttachments` 910 | | S |
| `buildEmlAttachment` 948 | | R2 `raw.eml` first, then rebuild |
| original-message loads in `forwardAndPersist` 1000, `replyAndPersist` 1126 | | S `getMessage(id,{bodies:true})` |
| `sendDraftAndPersist` 1195 | | S (drafts) |
| access.ts (all) | `mail_accounts` + `workspace_members` | P in postgres/shadow. `MailAccess` (directory + resolved role) in object modes |
| `emailEventData` 264 | | `MailAccess.isShared` |
| read-push.ts `workspaceInboxUnread` 90 | | F `stats(...).inboxUnread` |
| read-push.ts `sendWorkspaceMailReadPush` 166 | device tokens, members | P (+ F for the count) |
| outbound/correspondents.ts `findKnownCorrespondents` 22 | | L when authoritative, else P |
| `recordOutboundCorrespondents` 35 | | P (until the drop PR) + L (ledger `commit`) |
| `findSuppressed` 57, `addSuppression` 72 | | P |
| guard.ts `firstContactsOf` 361, `commitOutbound` 418, `recordCorrespondents` 442 | | L/P (§3, ledger) |
| delivery-events.ts `markSentCopy` 118, `applyToTenant` 220 | | S op `delivery.match`; suppressions stay P |
| workflows/send-scheduled-email.ts `resolveAttachments` 108, `outboundKindOf` 140, `loadScheduledSend` 204 (mark failed 234), failure update 282, `markScheduledSent` 333 | | S for messages; account and `sentToday` stay P |
| accounts.ts, folders.ts, uploads.ts, text.ts, recipient-validation.ts, contacts.ts, outbound/{cases,review,risk,fingerprint,content-screen,policy-store,consumers}.ts | | P / unchanged |

### `apps/workers/mail-api/src`

| Location | Class |
|---|---|
| routes/mail-messages/index.ts: list 130, stats 166, get 187, thread 210, patch 228, bulk 274 (direct `mail_messages` query 286-292 and all-accounts query 295-298), delete 337, labels add 369 / remove 399, reply 433, forward 492 | S + F (locate). Access through `MailAccess` |
| routes/mail-labels/index.ts: `canAccessMessageAccounts` 52-67 (direct `mail_messages`) | F locate |
| routes/mail-labels/index.ts: `/threads` 151 | S/F |
| routes/mail-labels/index.ts: add/remove-to-messages 182/210, apply-to-thread 238 | S |
| routes/mail-labels/index.ts: CRUD 276-402 | P rows + S counts/relabel. Fix: `GET /` without `accountId` lists every mailbox's labels (285) |
| routes/mail-threads/index.ts: read-all 44 | F |
| routes/mail-threads/index.ts: `/:threadId/read` 95 | S |
| routes/mail-snooze/index.ts: `/snoozed` 41 (fix the scope), snooze 62, unsnooze 92, resnooze 111 | S. `markWorkspaceDue` only while Postgres is written |
| routes/mail-attachments/index.ts: 71, 88, 138, 180, 198, 233, 259 | S, F locate |
| routes/mail-drafts/index.ts 49-158 | S |
| services/mail/scheduled.ts: `movableAttachmentIds` 46 (join) | F `locateAttachment` |
| services/mail/scheduled.ts: `scheduleEmail` 113 | S ingest (scheduled). Workflow params gain `wsId` |
| services/mail/scheduled.ts: `listScheduled` 232 | S/F |
| services/mail/scheduled.ts: `cancelScheduled` 242, `rescheduleScheduled` 269, `sendScheduledNow` 331 (hard deletes 416-417), `restoreSchedule` 444 | S ops `scheduled`, `delete{hard}` |
| services/mail/subscriptions.ts: `listSubscriptions` 36, `getSubscription` 50 | S |
| services/mail/subscriptions.ts: `scanSubscriptions` 59 (reads `raw_message`, always NULL today) | S `rawSources` + R2 header range reads + op `subscription.upsert` |
| services/mail/subscriptions.ts: `unsubscribe` 112 | S op `subscription.status` |
| services/mail/ai.ts: `loadMessage` 177, `loadAccessibleMessage` 189 | S/F |
| services/mail/ai.ts: `loadRecentMessages` 200 | F `recentMessages` |
| services/mail/ai.ts: `persistClassification` (~655; writes without `updatedAt`) | S op `categories` |
| services/mail/ai.ts: `loadAccountContext` ~160 | P |
| services/mail/accounts.ts: `listMailAccounts` 127 (selects `*`: **returns `accessToken`/`refreshToken`/`apiKey`/`passwordHash`/`providerConfig` to the browser** via route 152), `getMailAccount` 197, `getMailAccountLabels` 210 | P; served from the directory in object modes, credential columns removed |
| services/mail/accounts.ts: create 385, update 531, delete 566, assign 594 | P + directory bump; `ensureBackfill` on create |
| services/mail/weldmail.ts, sync.ts | P + directory bump |
| services/mail/mailboxes.ts | P (directory optional) |
| cron/snooze-sweep.ts `runSnoozeSweep` 60 | Postgres wake only for workspaces that are not object-only |
| lib/read-push.ts | F (count) |
| index.ts queue handler 100-109 (delivery events) | S |
| mail-campaigns, mail-domains, mail-rules, mail-signatures, mail-templates, mail-folders, mail-sending, mail-weldmail, mailboxes, mail-sync, internal-outbound | P |

### `apps/workers/mail-inbound-worker/src`

| Location | Class |
|---|---|
| lib/cf-email-adapter.ts:68 (`rawMessage` kept only when it is a string; Cloudflare always passes an `ArrayBuffer`) | keep the bytes; write `raw.eml` to R2 in every mode |
| lib/email-storage.ts `resolveWorkspaceRecipient` 285-380 | P (members, account) |
| `isTenantDuplicate` 627, `findThreadByReplyIds` 652, `findThreadBySubject` 698, `resolveTenantThread` 734 | S `resolveInbound`. Logic moves to mail-domain; the object runs it in-process |
| `storeEmail` 784 (insert 824-851) | S op `ingest` (inbound) |
| `upsertMailSubscription` 1264 | S, inside `ingest` |
| `storeWorkspaceAttachments` 914, `storeInboundAttachments` 1817 (html UPDATE 929-933) | R2 first; attachment rows inside `ingest`; no post-insert UPDATE |
| `loadAiLabelCandidates` 1353 (message read) | message from memory; labels P |
| `applyMatchedLabels` 1428 (+ `mail_labels.messageCount` bump) | S op `inbound.finalize`; tally X |
| `runMailRules` 1567, `executeRuleAction` 1792, `markMessageAsSpam` 1762, `applyLabelRule` 1775 | pure rule evaluation → S op `inbound.finalize`; rule stats P |
| `finishWorkspaceDelivery` 1067 | orchestration; contacts and notifications P |
| personal path (`storePersonalEmail` 543, `storePersonalAttachments` 1880, …) | out of scope |

### external-api (mcp-server has identical copies under `src/api/{lib,routes/v1}`)

| Location | Class |
|---|---|
| lib/mail.ts: `publicMessage` 31, `publicAttachment` 50, offset cursor 64-76 | add keyset cursor codecs |
| mail-messages: `reachableAccountId` 116 | F locate |
| mail-messages: list 134 | S/F |
| mail-messages: bulk 165 (direct `mailMessages` query 172-175) | F locate + S |
| mail-messages: get 196, attachments 210, patch 217, labels 239, move 262, delete 272 | S |
| mail-threads: list 55 (offset → keyset in object modes), get 86, read 96, labels 114 | S/F |
| mail-attachments: `reachableAttachment` 26 | F `locateAttachment` |
| mail-attachments: download 48 | R2, unchanged |
| mail-labels: list 77 (`listMailLabels` live counts) | P rows + S/F counts |
| mail-drafts 59-126 | S/F |
| mail-sending (external-api only): send 320, reply 352 (`getMessageAccountId` 358), forward 385 (391), draft send 418 | S via send.ts |
| mail-sending: upload 285 | unchanged |
| mail-accounts, mail-folders | P |
| mcp-server tools/mail/index.ts | unchanged (calls the routes) |

### Other workers and tools

| Location | Class |
|---|---|
| app-api routes/dashboard/index.ts `/sidebar-badges` 147-176 | F `unreadBadge` |
| app-api services/drive-aggregation.ts: `accessibleMailAttachments` 344, `aggregateAllFiles` 398-405, `aggregateStats` 561-566, `normalizeMailAttachments` 255 (returns the public `downloadUrl`, 262) | F `recentAttachments`; url → `/api/mail-attachments/:id/download` |
| app-api routes/_test-fixtures/index.ts (reset 247-260, seed 1118), seed-mail-bulk.ts | S (`applyBatch` ingest; `delete{hard}` by test marker) |
| app-api app-access, app-catalog (`isAdminOrOwner`), routes/internal + services/internal-email.ts (guard) | P |
| crm: packages/domains/crm/src/people.ts `recentAccountEmails` 1415, `listRecentCorrespondents` 1458; crm-api routes/people/index.ts 157-171 (**no mailbox access check on `accountId`**) | S `recentAddresses`; the route resolves the addresses and checks access |
| crm execute-workflow/entity-tables.ts:48, workflow-worker engine/entity-tables.ts:48 (`mail_message` generic CRUD bypasses MAIL-003), UI `entity-type-select.tsx:91`, i18n `weldconnect.ts:2072` (en/nl), es:1530 | X |
| crm action-handlers.ts, execute-sequence.ts; workflow-worker send email; desk-api desk-email.ts, channel-dispatch.ts, outbound-guard.ts; calendar-api calendar-mail.ts; meet-api invitations.ts; sign mail.ts | guard only → P + L through the guard |
| books-api, host-api | no mail content access |
| workspace-worker services/workspace-mail.ts `ensureWorkspaceMail` 67, routes/backfill-mail.ts | P + directory bump |
| workspace-worker routes/webhooks/clerk.ts `handleOrganizationDeleted` 339-404; services/teardown-sweep.ts `retryTeardown` 65 | add mailbox destroy + ledger forget (§7) |
| workspace-worker lib/database-move/* | unchanged (catalog-driven) |
| tools/outbound-audit tenant-queries.ts `collectSentRecipients` 81, `loadFirstInbound` 99, `streamSentMessages` 123; index.ts 95-105 | object-only workspaces: read through `/internal/mail-store/export` + the ledger |
| tools/migrate-databases audit-custom-field-blobs.ts:56, backfill-pile-a-columns.ts:87, extract-blob-fields.ts:55-67 | P now; X with the drop PR |
| personal-api | out of scope |

## 2. Interfaces in `@weldsuite/mail-domain`

New files under `packages/domains/mail/src/store/` (exported as `./store`, `./store/types`) and `src/mailbox-object/` (exported as `./mailbox-object`).

**Decisions in this section:**
- **Drafts move into the object.** The stats endpoint counts them and the sidebar reads them on open. The plan's phase 3 already lists drafts in the interface; they were not in "What stays in Postgres".
- **No Drizzle inside the object.** Reasons:
  - FTS5, partial indexes and triggers cannot come from drizzle-kit, so the migrations would be custom anyway.
  - The hot paths are hand-written SQL inside `transactionSync`.
  - The node:sqlite fake would have to emulate drizzle's `durable-sqlite` session (`raw()` iterators and so on).

  The object uses plain `ctx.storage.sql.exec` through a typed helper. The migration SQL is the single schema source, and a test checks every row mapper against `PRAGMA table_info`.

```ts
// store/types.ts
export const MAILBOX_STORE_FLAG = 'weldmail-mailbox-store';
export type MailStoreMode = 'postgres' | 'shadow' | 'object' | 'object-only';
export interface MailboxRef { workspaceId: string /* ws_… */; accountId: string; clerkOrgId?: string | null }

/** Postgres row shape in every mode; bodies only on request. Fields the object does not keep come back null. */
export type MailMessageRecord = Omit<MailMessage, 'textBody' | 'htmlBody' | 'rawMessage'> &
  { threadKey: string; textBody?: string | null; htmlBody?: string | null; rawMessage?: null };
export type MailMessageListRow = ThreadListMessage & { threadKey: string };     // phase-1 lean shape
export type MailAttachmentRecord = MailAttachment;                               // storagePath stays server-side
export type FolderKey = string;   // lower-case: 'inbox','sent',…,'__all','__total','__scheduled', lower(user label)

export interface ThreadFilter { labelSlug: string; search?: string; from?: string; to?: string; subject?: string;
  hasAttachment?: boolean; excludeWords?: string }
export interface ThreadCursor { latestAt: number; accountId: string; threadKey: string }       // global total order
export interface ThreadListQuery extends ThreadFilter { pageSize: number; cursor?: ThreadCursor | null;
  offset?: number /* legacy page/offset, capped at 5000 */; withMessages?: boolean }
export interface ThreadPage { threads: ThreadSummary[]; totalCount: number; nextCursor: ThreadCursor | null }

export interface MessageCursor { sentAt: number; id: string }
export interface MessageListQuery { limit: number; cursor?: MessageCursor | null; search?: string; from?: string;
  label?: string; threadId?: string; isRead?: boolean; isStarred?: boolean; isFlagged?: boolean; hasAttachments?: boolean;
  excludeTrash?: boolean; excludeSpam?: boolean; counterparty?: string /* exact address: CRM tab */ }
export interface MessagePage { data: MailMessageListRow[]; totalCount: number; nextCursor: MessageCursor | null }

export interface LabelCount { messages: number; unread: number; threads: number }
export interface MailboxStats extends MessageStats { labels: Record<FolderKey, LabelCount> }
export interface InboundThreadQuery { rfcMessageId: string; inReplyTo?: string | null; references?: string[] | null;
  subject: string; fromEmail?: string | null; isReply: boolean }

export interface IngestMessage {
  id: string;                                  // generated by the writer before the first store write: the idempotency key
  source: 'inbound' | 'sent' | 'scheduled';
  rfcMessageId: string; externalMessageId?: string | null; providerMessageId?: string | null;
  threadId: string | null;                     // from the primary; null + threadHints = the object resolves it
  threadHints?: InboundThreadQuery;
  from: MailEmailAddress; to: MailEmailAddress[]; cc?: MailEmailAddress[] | null; bcc?: MailEmailAddress[] | null;
  replyTo?: MailEmailAddress | null; subject: string | null; preview: string | null;
  sentAt: number; receivedAt: number | null; createdAt: number;
  isRead: boolean; labels: string[]; isSpam: boolean;
  inReplyTo?: string | null; references?: string[] | null; isReply: boolean; isForwarded?: boolean;
  priority?: string | null; sizeBytes?: number | null;
  spfStatus?: string | null; dkimStatus?: string | null; dmarcStatus?: string | null;
  sendStatus?: string | null; scheduledFor?: number | null; triggerRunId?: string | null; idempotencyKey?: string | null;
  delivery?: { status: MailDeliveryStatus; detail: string; at: number } | null;
  content?: { html?: string | null; text?: string | null };   // worker-side only; never sent over RPC
  bodies?: { html: boolean; text: boolean; raw: boolean };    // presence bits, set by the object client after its R2 puts
  searchText?: string;                                        // ≤ 8 KB plain text for FTS
  attachments: Array<AttachmentInput & { id: string }>;       // objects already in R2
  subscription?: SubscriptionValues | null;                   // ham inbound with List-Unsubscribe
  extra?: Partial<Pick<MailMessage, 'headers' | 'customFields' | 'clickedLinks' | 'conversationId'>>;
}

export type FlagPatch = Partial<Record<'isRead' | 'isStarred' | 'isFlagged' | 'isImportant' | 'isSpam' | 'isTrash', boolean>>;
/** Every write is one op. Semantics mirror today's functions exactly ('single' = updateMessage/addMessageLabels, 'bulk' = bulk*). */
export type MailboxOp =
  | { kind: 'ingest'; message: IngestMessage }
  | { kind: 'flags'; ids: string[]; patch: FlagPatch; semantics: 'single' | 'bulk' }
  | { kind: 'labels.set'; id: string; labels: string[] }
  | { kind: 'labels.add' | 'labels.remove'; ids: string[]; labels: string[]; semantics: 'single' | 'bulk' }
  | { kind: 'move'; ids: string[]; location: LocationLabel }                    // trash/archive/spam/restore
  | { kind: 'thread.label'; threadKey: string; label: string; action: 'add' | 'remove' }
  | { kind: 'thread.read'; threadKey: string; isRead: boolean }
  | { kind: 'folder.read'; scope: ThreadFilter; batchSize?: number; maxBatches?: number; keepIds?: number }
  | { kind: 'thread.set'; id: string; threadId: string }
  | { kind: 'label.rename'; from: string; to: string } | { kind: 'label.delete'; name: string }
  | { kind: 'delete'; ids: string[]; hard?: boolean }
  | { kind: 'snooze' | 'resnooze'; id: string; until: number } | { kind: 'unsnooze'; id: string }
  | { kind: 'snooze.wake'; now: number }
  | { kind: 'scheduled'; id: string; patch: { sendStatus?: 'scheduled' | 'sent' | 'cancelled' | 'failed';
      scheduledFor?: number | null; triggerRunId?: string | null; sentAt?: number; externalMessageId?: string;
      dropScheduledLabel?: boolean; softDelete?: boolean; delivery?: { status: MailDeliveryStatus; detail: string | null } } }
  | { kind: 'delivery.match'; recipient: string; eventAt: number; status: MailDeliveryStatus; detail: string | null }
  | { kind: 'inbound.finalize'; id: string; addLabels: string[]; removeLabels: string[]; isRead?: boolean; isFlagged?: boolean; isSpam?: boolean; deleted?: boolean }
  | { kind: 'categories'; id: string; categories: string[]; important?: boolean }
  | { kind: 'attachment.create'; attachment: AttachmentInput & { id: string } }
  | { kind: 'attachment.update'; id: string; patch: Partial<AttachmentInput> }
  | { kind: 'attachment.delete'; id: string }
  | { kind: 'attachment.associate'; messageId: string; attachmentIds: string[] }  // within one mailbox
  | { kind: 'subscription.upsert'; values: SubscriptionValues[] }
  | { kind: 'subscription.status'; id: string; patch: { status: 'unsubscribed'; method: MailUnsubscribeMethod; at: number; by: string } }
  | { kind: 'draft.create'; draft: DraftInput & { id: string } } | { kind: 'draft.update'; id: string; patch: Partial<DraftInput> }
  | { kind: 'draft.delete'; id: string };

export interface IngestResult { id: string; threadKey: string; created: boolean; duplicateOf?: string }
export interface OpResult { applied: string[]; missing: string[]; stale: string[];
  updatedIds?: string[] /* folder.read, thread.read: every id, for the secondary */; labels?: Record<string, string[]>;
  message?: MailMessageRecord | null; ingest?: IngestResult; storagePaths?: string[]; ready: boolean }

export interface MailboxStore {
  readonly ref: MailboxRef; readonly backend: 'postgres' | 'object';
  // reads
  listThreads(q: ThreadListQuery): Promise<ThreadPage>;
  getThread(threadKey: string): Promise<{ threadId: string; accountId: string; messages: MailMessageRecord[] } | null>;
  getThreadOfMessage(messageId: string): Promise<{ threadId: string; messages: MailMessageRecord[] } | null>;
  getMessage(id: string, o?: { bodies?: boolean; attachments?: boolean }): Promise<(MailMessageRecord & { attachments?: MailAttachmentRecord[] }) | null>;
  getMessages(ids: string[]): Promise<MailMessageListRow[]>;            // live rows in THIS mailbox (locate, bulk checks)
  listMessages(q: MessageListQuery): Promise<MessagePage>;              // keyset sentAt desc, id desc; search = FTS in the object
  stats(): Promise<MailboxStats>;
  unreadCount(scope: 'inbox' | 'all-live'): Promise<number>;
  labelCounts(keys: FolderKey[]): Promise<Record<FolderKey, LabelCount>>;
  listAttachments(messageId: string): Promise<MailAttachmentRecord[]>;
  getAttachment(id: string): Promise<(MailAttachmentRecord & { accountId: string }) | null>;
  recentAttachments(q: { before?: { createdAt: number; id: string }; limit: number }): Promise<{ data: MailAttachmentRecord[]; totalCount: number }>;
  recentAddresses(limit: number): Promise<string[]>;                     // CRM recent correspondents
  resolveInbound(q: InboundThreadQuery): Promise<{ duplicate: boolean; threadId: string; isExistingHamThread: boolean }>;
  findByRfcIds(ids: string[], providerIds: string[]): Promise<Array<{ id: string; threadId: string | null; source: string | null }>>;
  findSentByIdempotencyKey(key: string): Promise<{ id: string; rfcMessageId: string; externalMessageId: string | null; subject: string | null } | null>;
  countSentSince(since: number): Promise<number>;                         // deleted included, like countSentToday
  listScheduled(): Promise<MailMessageRecord[]>; listSnoozed(): Promise<SnoozedMessage[]>;
  listSubscriptions(q: { status?: 'active' | 'unsubscribed' }): Promise<MailSubscription[]>; getSubscription(id: string): Promise<MailSubscription | null>;
  rawSources(q: { since: number; limit: number }): Promise<Array<{ id: string; from: MailEmailAddress; subject: string | null; receivedAt: number }>>;
  listDrafts(q: { limit: number; cursor?: string }): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }>;
  getDraft(id: string): Promise<MailDraft | null>;
  exportPage(q: { cursor?: string; limit: number; sentOnly?: boolean; since?: number; until?: number }): Promise<{ data: MailMessageRecord[]; cursor: string | null }>;
  // writes
  apply(op: MailboxOp, at?: number): Promise<OpResult>;    // `at` = the writer's clock (ms); the router supplies it
  applyBatch(ops: MailboxOp[], at?: number): Promise<OpResult[]>;
}

export interface WorkspaceMailStore {
  readonly workspaceId: string; readonly clerkOrgId: string; readonly mode: MailStoreMode;
  mailbox(accountId: string): MailboxStore;                               // routed: dual-write per mode (§2.2)
  listThreads(accountIds: string[], q: ThreadListQuery): Promise<ThreadPage>;            // unified inbox
  listMessages(accountIds: string[], q: MessageListQuery): Promise<MessagePage>;
  stats(accountIds: string[]): Promise<MessageStats>;
  unreadBadge(accountIds: string[]): Promise<number>;
  locateMessages(ids: string[], accountIds: string[], hint?: string): Promise<Map<string, string>>;
  locateAttachment(id: string, accountIds: string[], hint?: string): Promise<{ accountId: string; attachment: MailAttachmentRecord } | null>;
  locateDraft(id: string, accountIds: string[], hint?: string): Promise<{ accountId: string; draft: MailDraft } | null>;
  messagesByCounterparty(address: string, accountIds: string[], q: { cursor?: MessageCursor; limit: number }): Promise<MessagePage>;
  recentAttachments(accountIds: string[], q: { limit: number }): Promise<{ data: Array<MailAttachmentRecord & { accountId: string }>; totalCount: number }>;
  recentMessages(accountIds: string[], limit: number): Promise<MailMessageListRow[]>;     // AI context
  markFolderRead(accountIds: string[], scope: ThreadFilter, o?: MarkFolderReadOptions): Promise<{ updatedCount: number; updated: { id: string; accountId: string }[] }>;
  listSnoozed(accountIds: string[]): Promise<SnoozedMessage[]>; listScheduled(accountIds: string[]): Promise<MailMessageRecord[]>;
  listDrafts(accountIds: string[], q: { limit: number; cursor?: string }): Promise<{ data: MailDraft[]; hasMore: boolean; cursor: string | null; totalCount: number }>;
}

export interface MailAccess {                    // §6
  isAdmin(): Promise<boolean>; canOpen(accountId: string): Promise<boolean>; canManage(accountId: string): Promise<boolean>;
  accessibleAccountIds(): Promise<string[]>; account(accountId: string): Promise<DirectoryAccount | null>;
  accounts(scope?: 'open' | 'manage'): Promise<DirectoryAccount[]>; labels(accountId: string): Promise<DirectoryLabel[]>;
  isShared(accountId: string): Promise<boolean>;
}
export interface WorkspaceMail { mode: MailStoreMode; store: WorkspaceMailStore; access: MailAccess; bodies: MailBodies }

export interface MailStoreEnv { MAILBOX_STORE?: DurableObjectNamespace<MailboxObject>; STORAGE?: R2Bucket; PRIVATE_STORAGE?: R2Bucket;
  WORKSPACE_CACHE: KVNamespace; FLAGSHIP?: FlagshipLike; ENVIRONMENT?: string; MAILBOX_PARITY_SAMPLE_RATE?: string;
  OUTBOUND_LEDGER?: DurableObjectNamespace<OutboundLedger> }

/** Hono: memoised on the context; reads flags, workspaceId, clerkOrgId, the resolved role, executionCtx.waitUntil. */
export function getWorkspaceMail(c: Context<{ Bindings: MailStoreEnv & DbEnv; Variables: KitVariables }>): Promise<WorkspaceMail>;
/** Inbound worker, workflow, queue consumer, workspace-worker, DO. */
export function createWorkspaceMail(d: { env: MailStoreEnv & DbEnv; workspaceId: string; clerkOrgId: string;
  db: () => Promise<Database>; principal?: MailPrincipal; role?: string | null; mode?: MailStoreMode;
  waitUntil?: (p: Promise<unknown>) => void }): Promise<WorkspaceMail>;
export function readMailboxStoreMode(env: Pick<MailStoreEnv, 'FLAGSHIP' | 'ENVIRONMENT'>, workspaceId: string): Promise<MailStoreMode>;
export function mailboxStub(env: Pick<MailStoreEnv, 'MAILBOX_STORE'>, ref: MailboxRef): DurableObjectStub<MailboxObject>;
// = ns.jurisdiction('eu').get(ns.jurisdiction('eu').idFromName(`mbx:${ref.workspaceId}:${ref.accountId}`)). The only call site;
//   a test greps for any other `MAILBOX_STORE.idFromName`.
```

### 2.1 Implementations

- **`store/postgres/mailbox-store.ts` (`PostgresMailboxStore(db, ref)`)** wraps today's functions.
  - It needs these refactors:
    - access is split out of `listThreadsByLabel`/`threadListScope`, giving `listThreadsForAccounts(db, accountIds, …)`;
    - every mutating function takes `now?: Date` (from `at`);
    - `markSentCopy` and `persistClassification` set `updatedAt` (today they don't, and catch-up needs it);
    - the scheduled, subscription and AI message code moves from mail-api into `store/postgres/`;
    - inbound insert, duplicate check and thread resolution move from email-storage.ts into `store/postgres/inbound.ts`.
  - `ingest` uses `onConflictDoNothing` on `id`.
  - `apply` dispatches by `op.kind` to the existing function with the same semantics.
- **`store/postgres/workspace-store.ts`** answers the cross-mailbox reads with single SQL queries over `accountIds`, as today.
- **`store/object/mailbox-store.ts` (`ObjectMailboxStore(env, ref)`)** is a thin RPC client.
  - For `ingest` it first puts `content.html`/`content.text` to R2 (`mail/<ws>/<acct>/<id>/body.html|body.txt`, `store/bodies.ts`), then sets `bodies` bits and `searchText` and strips `content`.
  - `getMessage(…,{bodies})` reads R2 in parallel after the RPC. If `body_bits` is 0 and mode is `object`, it falls back to Postgres.
- **`store/object/workspace-store.ts`** does the fan-out and k-way merge (§5).

### 2.2 Router (`store/router.ts`) and dual writes

The effective mode is per mailbox. `object` and `object-only` are demoted to shadow behaviour while the object reports `ready=false` (backfill not done). `status()` is cached per isolate for 60 s, and a write result's `ready` updates the cache.

| Mode | Primary (awaited; its failure fails the request) | Secondary (`waitUntil`, never fails the request) | Reads |
|---|---|---|---|
| `postgres` | Postgres | none | Postgres |
| `shadow` | Postgres | object | Postgres; parity sampled; on open: `ensureBackfill` + rate-limited `catchUp` |
| `object` | object | Postgres | object; if the object throws, fall back to Postgres and log |
| `object-only` | object | none | object (no fallback) |

- **Idempotency:**
  - The message id is generated by the writer before the first write: `msg_${nanoid()}` inbound, `generateId('msg')` for sends and scheduled sends. Both stores get the same id. Attachment and draft ids work the same way.
  - `ingest` is insert-if-absent. On replay it returns `created:false`, and the subscription bump, the outbox row and the FTS row only happen when the row was created.
  - Inbound duplicates by RFC id: the primary's `resolveInbound` returns `duplicate`. The object also refuses an inbound RFC id that already exists under another id (`duplicateOf`).
  - Sent-copy idempotency key: a unique index in both stores; a conflict returns the existing row.
- **Making the secondary deterministic:** the router rewrites the op from the primary's result before sending it on.
  - `ingest` gets `threadId` from the primary.
  - `folder.read`/`thread.read` become `flags{ids: updatedIds, patch:{isRead}}` in chunks of 1000.
  - `snooze.wake` is never dual-written: each store wakes on its own rule.
- **Ordering:** each message keeps a last-write-wins clock per field group (`clk_read`, `clk_labels`, `clk_flag`, `clk_delete`, `clk_snooze`, `clk_send`, `clk_delivery`, `clk_meta`) in the object. An op is skipped (`stale`) if `at` is below the clock of a group it touches. Ops on different groups commute, so a reordered secondary converges.
- **When the secondary fails:**
  - **shadow (object failed):**
    - log `mailbox_secondary_write_failed {workspaceId, accountId, kind, ids}`;
    - set KV `mbxdrift:<ws>:<acct>` (TTL 1 day);
    - the next shadow read of that mailbox runs `catchUp` (Postgres → object by `updated_at` watermark), and full parity also repairs it;
    - `missing` ids while backfill is still running are not failures (the backfill copies them).
  - **object (Postgres failed):**
    - log, then `stub.notePgDrift(ids)`;
    - the object's alarm mirrors its state for those ids to Postgres with backoff (inserting missing rows with bodies read from R2);
    - before any rollback from `object` or `object-only`, an admin runs `reverseSync(since)` (§4).
- **Parity sampling** (shadow, single-mailbox `listThreads` and `stats`, rate `MAILBOX_PARITY_SAMPLE_RATE`, default 0.05; searches skipped): `waitUntil` compares Postgres with the object.
  - Compared: all stats fields; the first page's thread keys and their order; per thread `messageCount`, `unreadCount`, `latestMessageId` and the label set.
  - Labels are compared after normalisation, flags folded into labels (`store/model.ts normalizeLegacy`).
  - One log line `mailbox_parity` with ids and counts only, no content. A mismatch triggers `catchUp`.
- **Mode flag:** `readMailboxStoreMode` evaluates Flagship with attributes `{workspaceId, environment, app}`, caches per isolate for 30 s, and treats unknown values as `postgres`.
  - Mixed modes across isolates during a flip are safe: both stores still receive every write in the overlapping modes.

## 3. The Durable Object (`packages/domains/mail/src/mailbox-object/`)

`mailbox-object.ts` exports `class MailboxObject extends DurableObject<MailboxObjectEnv>`. mail-api re-exports it: `export { MailboxObject as MailboxStore } from '@weldsuite/mail-domain/mailbox-object'`. Its env is mail-api's: `STORAGE`, `OUTBOUND_LEDGER`, `ENTITY_EVENTS`, DB env for backfill, `FLAGSHIP`.

### 3.1 DDL

Migration version 1. Each string is one statement, all run inside `transactionSync`.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- keys: schema_version, workspace_id, account_id, clerk_org_id, backfill (json state), pg_sync_at, last_catchup_at,
--       last_parity (json), size_warned_at, fts_trim_before, destroying (json progress), created_at

CREATE TABLE messages (
  id TEXT PRIMARY KEY, rfc_message_id TEXT NOT NULL, external_message_id TEXT, provider_message_id TEXT,
  thread_id TEXT, thread_key TEXT NOT NULL, conversation_id TEXT,
  from_email TEXT NOT NULL DEFAULT '', from_name TEXT, from_json TEXT NOT NULL,
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT, bcc_json TEXT, reply_to_json TEXT,
  subject TEXT, subject_norm TEXT, preview TEXT,
  sent_at INTEGER NOT NULL, received_at INTEGER, sort_at INTEGER NOT NULL,      -- sort_at = COALESCE(received, sent, created)
  is_read INTEGER NOT NULL DEFAULT 0, is_flagged INTEGER NOT NULL DEFAULT 0, is_draft INTEGER NOT NULL DEFAULT 0,
  is_reply INTEGER NOT NULL DEFAULT 0, is_forwarded INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]', categories_json TEXT,
  in_trash INTEGER NOT NULL DEFAULT 0, in_spam INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0, important INTEGER NOT NULL DEFAULT 0,          -- derived from labels on every write
  has_attachments INTEGER NOT NULL DEFAULT 0, attachment_count INTEGER NOT NULL DEFAULT 0,
  in_reply_to TEXT, references_json TEXT, priority TEXT, size_bytes INTEGER,
  spf_status TEXT, dkim_status TEXT, dmarc_status TEXT, source TEXT,
  send_status TEXT, scheduled_for INTEGER, trigger_run_id TEXT, idempotency_key TEXT,
  snoozed_until INTEGER, snoozed_at INTEGER, unsnoozed_at INTEGER, unsnoozed_early INTEGER, resnoozed_at INTEGER,
  delivery_status TEXT, delivery_detail TEXT, delivery_updated_at INTEGER,
  body_bits INTEGER NOT NULL DEFAULT 0,            -- 1 body.html, 2 body.txt, 4 raw.eml in R2 (deterministic keys)
  extra_json TEXT,                                 -- headers, customFields (e2e marker), clickedLinks, receipts, provider ids
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  clk_read INTEGER NOT NULL DEFAULT 0, clk_labels INTEGER NOT NULL DEFAULT 0, clk_flag INTEGER NOT NULL DEFAULT 0,
  clk_delete INTEGER NOT NULL DEFAULT 0, clk_snooze INTEGER NOT NULL DEFAULT 0, clk_send INTEGER NOT NULL DEFAULT 0,
  clk_delivery INTEGER NOT NULL DEFAULT 0, clk_meta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_rfc_idx ON messages(rfc_message_id);
CREATE INDEX messages_ext_idx ON messages(external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX messages_provider_idx ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_thread_idx ON messages(thread_key, sort_at);
CREATE INDEX messages_list_idx ON messages(sent_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX messages_subject_idx ON messages(subject_norm, sent_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX messages_snooze_idx ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX messages_scheduled_idx ON messages(scheduled_for) WHERE send_status = 'scheduled';
CREATE UNIQUE INDEX messages_idem_idx ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_source_sent_idx ON messages(source, sent_at);                 -- countSentSince, export
CREATE INDEX messages_updated_idx ON messages(updated_at);                          -- reverse sync, parity
CREATE INDEX messages_unread_idx ON messages(sort_at DESC) WHERE is_read = 0 AND deleted_at IS NULL;

CREATE TABLE message_labels (label_key TEXT NOT NULL, message_id TEXT NOT NULL,
  PRIMARY KEY (label_key, message_id)) WITHOUT ROWID;                              -- label_key = lower(label)
CREATE INDEX message_labels_msg_idx ON message_labels(message_id);

CREATE TABLE message_addresses (address TEXT NOT NULL, sent_at INTEGER NOT NULL, message_id TEXT NOT NULL,
  role TEXT NOT NULL, name TEXT, PRIMARY KEY (address, sent_at, message_id, role)) WITHOUT ROWID;
CREATE INDEX message_addresses_msg_idx ON message_addresses(message_id);
-- needed for: delivery-status match, CRM counterparty, recent correspondents, To/From filters. Missing from the plan.

CREATE TABLE threads (thread_key TEXT PRIMARY KEY, latest_at INTEGER NOT NULL, latest_message_id TEXT NOT NULL,
  first_message_id TEXT NOT NULL, subject TEXT, preview TEXT, latest_from_json TEXT,
  participants_json TEXT NOT NULL, labels_json TEXT NOT NULL, message_count INTEGER NOT NULL,
  unread_count INTEGER NOT NULL, has_attachments INTEGER NOT NULL, is_starred INTEGER NOT NULL,
  scheduled_for INTEGER, send_status TEXT, updated_at INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE thread_labels (label_key TEXT NOT NULL, thread_key TEXT NOT NULL, latest_at INTEGER NOT NULL,
  match_count INTEGER NOT NULL, PRIMARY KEY (label_key, thread_key)) WITHOUT ROWID;
CREATE INDEX thread_labels_page_idx ON thread_labels(label_key, latest_at DESC, thread_key);
CREATE INDEX thread_labels_thread_idx ON thread_labels(thread_key);

CREATE TABLE label_counts (label_key TEXT PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0, threads INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;

CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0, is_inline INTEGER NOT NULL DEFAULT 0, content_id TEXT, content_disposition TEXT,
  checksum TEXT, storage_path TEXT, download_url TEXT, external_attachment_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX attachments_msg_idx ON attachments(message_id);
CREATE INDEX attachments_recent_idx ON attachments(created_at DESC, id DESC) WHERE deleted_at IS NULL AND is_inline = 0;

CREATE VIRTUAL TABLE messages_fts USING fts5(subject, sender, recipients, preview, body,
  content='', contentless_delete=1, detail=column, tokenize='unicode61 remove_diacritics 2');
-- rowid = messages.rowid. detail=column: column filters and prefixes work; phrases do not (verified on node:sqlite 3.51).

CREATE TABLE subscriptions (id TEXT PRIMARY KEY, sender_email TEXT NOT NULL UNIQUE, sender_name TEXT, sender_domain TEXT,
  list_id TEXT, unsubscribe_url TEXT, unsubscribe_mailto TEXT, one_click INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0, last_subject TEXT, first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', unsubscribe_method TEXT,
  unsubscribed_at INTEGER, unsubscribed_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX subscriptions_recent_idx ON subscriptions(last_received_at DESC);

CREATE TABLE drafts (id TEXT PRIMARY KEY, subject TEXT, to_json TEXT, cc_json TEXT, bcc_json TEXT, reply_to_json TEXT,
  body TEXT, html_body TEXT, importance TEXT, labels_json TEXT, attachment_ids_json TEXT, in_reply_to TEXT,
  original_message_id TEXT, is_reply INTEGER, is_forward INTEGER, has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0, last_auto_saved_at INTEGER, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX drafts_updated_idx ON drafts(updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX outbox_due_idx ON outbox(next_attempt_at);
CREATE TABLE pg_drift (message_id TEXT PRIMARY KEY, noted_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL) WITHOUT ROWID;
```

### 3.2 Keeping derived tables right (pure rules in `store/model.ts`, applied inside one `transactionSync` per op)

**`folderKeys(state)`** reproduces today's SQL rules: `inTrashOrSpamCondition`, `labelFolderHidesArchived`, `labelCondition` and the stats filters.
- A deleted message has no keys. Otherwise `__total` always applies.
- Let `tos` mean the message is in trash or spam.
- If not `tos`: add `__all`.
- For each label:
  - `trash` / `spam` → add the key;
  - another system label → add the key if not `tos`;
  - a user label → add the key if neither `tos` nor archived.
- `__scheduled` applies with the SCHEDULED label, `send_status='scheduled'` and not `tos`.

**Every message change** goes through `changeMessage(id, groups, mutate, at)`:
1. Load the state. Check the LWW clocks of the groups the op touches.
2. Apply the pure mutation, reusing labels.ts semantics (`addLabels`, `removeLabels`, `flagsForLabelChange`, `labelsForFlagPatch`, move semantics with `CLEARED_BY_MOVE` and `OUTGOING_LABELS`).
3. Write the row, recomputing the derived flags; `updated_at = max(updated_at, at)`; set the group clocks to `at`.
4. Diff `message_labels`.
5. For each folder key whose membership or unread state changed:
   - adjust `label_counts.messages` and `label_counts.unread`;
   - for thread-level keys (all but `__total` and `__scheduled`), adjust `thread_labels.match_count`;
   - when a row goes 0→1: insert it and add 1 to `label_counts.threads`; when it goes 1→0: delete it and subtract 1.
6. Collect the thread key.

At the end of the op, **`refreshThread(key)`** recomputes the summary from the thread's live messages (index `messages_thread_idx`, capped at 1000):
- the same algorithm as `buildThreadSummary`/`summarizeThreadMessages`;
- writes the `threads` row (or deletes it when no live message is left);
- updates `thread_labels.latest_at` for that thread.

**Per-op notes:**
- **Ingest:**
  - insert the row; `message_labels`;
  - `message_addresses` for from/to/cc/bcc;
  - the FTS row (`INSERT INTO messages_fts(rowid,…) SELECT rowid,… FROM messages WHERE id=?`);
  - attachments; the subscription upsert (when created and ham);
  - folder deltas from nothing; `refreshThread`;
  - an outbox row `ledger.mail` `{accountId, inbound: from-address if source≠sent, addresses[], at}`.
- **Hard delete** also removes the FTS row, addresses, labels and attachments, and returns the R2 paths for the caller to delete.
- **`label.rename` / `label.delete`:**
  - rewrite `message_labels.label_key` and `labels_json` (case-insensitive, like labels.ts:479-494);
  - rename or delete the `label_counts` and `thread_labels` keys;
  - refresh the affected threads.
- **`folder.read`:** threads from `thread_labels` (or the filtered path), unread messages in batches of 1000, one transaction per batch, up to `maxBatches`. Returns `updatedIds` (all of them) and the 200 newest per mailbox for the push.
- **`delivery.match`:** `message_addresses(address=recipient, role in to/cc/bcc)` joined with `messages`, where `source='sent'` and `sent_at` is between `eventAt − 3 d` and `eventAt + 1 h`; take the latest; apply `STATUS_RANK` as in delivery-events.ts:108-148.
- **`inbound.finalize`** applies a DELTA, not an absolute snapshot: `addLabels`/`removeLabels` merge onto the row's current labels (same idempotent semantics as `labels.add`/`labels.remove`), and `isRead`/`isFlagged`/`isSpam`/`deleted` are only written when the op sets them — the classification call behind this op can take seconds, during which a user can read/flag/archive the same message, and an absolute snapshot taken before that call would otherwise undo it. The inbound worker computes the before/after state in memory (AI matched labels as a plain union, then rule actions through a pure `applyRuleAction` moved from email-storage.ts:1727-1810; rule conditions are evaluated on the parsed email) and diffs the two into the delta (`finalizeOpFromStates`).

**Stats map:**

| `MessageStats` field | Source |
|---|---|
| `total` / `unread` | `__total` messages / unread |
| `inboxUnread` | `inbox` unread |
| `starred` | `starred` messages |
| `importantUnread` | `important` unread |
| `sentUnread` / `archiveUnread` / `trashUnread` | unread of `sent` / `archive` / `trash` |
| `spam` / `snoozed` | `spam` / `snoozed` messages |
| `scheduled` | `__scheduled` messages |
| `drafts` | live drafts count |
| sidebar badge | `__all` unread |
| a user label's badge | `label_counts[lower(name)].messages` |

### 3.3 Reads (`reads.ts`)

- **Fast path, folder without filters** (the folder's thread count comes from `label_counts.threads`):
  ```sql
  SELECT t.* FROM thread_labels tl JOIN threads t USING(thread_key)
  WHERE tl.label_key=?1 AND (tl.latest_at < ?2 OR (tl.latest_at = ?2 AND (?3='all' OR (?3='gt' AND tl.thread_key > ?4))))
  ORDER BY tl.latest_at DESC, tl.thread_key LIMIT ?5
  ```
  `?3` is computed by the worker from the cursor's `accountId` compared with this mailbox's: `all` / `none` / `gt`. Offset mode uses `LIMIT/OFFSET`. Lean messages for the page come from one `IN (thread keys)` query.
- **Filtered or search path:**
  - matching message threads come from `messages` plus: folder conditions (`EXISTS message_labels` plus `in_trash`/`in_spam`/`archived`); `from_email`/`from_name`/recipient `LIKE`; `subject LIKE`; and the FTS rowid join for search;
  - then join `threads` for `has_attachments`, and `NOT EXISTS` an FTS match within the thread for `excludeWords` (`{subject sender preview body}: (w1* OR w2*)`);
  - the same keyset;
  - `count(DISTINCT thread_key)` for the total.
- **FTS query builder (`store/fts-query.ts`):** split terms on non-letters/digits, lower-case them (so `AND`/`OR` are never operators), emit `tok*` joined by AND. Never phrases: they error with `detail=column`.
- **Snooze:** a read first wakes due snoozes in-process when `now ≥ meta.next_snooze_due` (cheap, local).

### 3.4 Versioning and migrations

- `MIGRATIONS: { version: number; statements: string[] }[]`.
- The constructor runs `ctx.blockConcurrencyWhile(() => migrate())`:
  - create `meta` if absent; read `schema_version`;
  - apply each newer migration in its own `transactionSync`.
- Migrations run lazily on first access of each object, never by a deploy fan-out.
- Migrations are append-only, and a test applies them from every intermediate version.

### 3.5 RPC methods

Every method takes `ref` first. `bindRef` writes `workspace_id`/`account_id` into `meta` on the first write and rejects a mismatch.

- **Status:** `status`.
- **Reads:**
  - `listThreads`, `getThread`, `getThreadOfMessage`, `getMessages`, `listMessages`, `stats`, `labelCounts`;
  - `messagesByAddress`, `recentAddresses`;
  - `listAttachments`, `getAttachment`, `recentAttachments`;
  - `resolveInbound`, `findByRfcIds`, `findSentByIdempotencyKey`, `countSentSince`;
  - `listScheduled`, `listSnoozed`, `listSubscriptions`, `getSubscription`, `rawSources`;
  - `listDrafts`, `getDraft`, `exportPage`.
- **Writes:** `apply(ref, op, at)`, `applyBatch(ref, ops, at)`, `notePgDrift(ref, ids)`.
- **Maintenance:** `ensureBackfill`, `catchUp`, `parity`, `reverseSync`, `rebuildDerived`, `destroy`.
- **Alarm:** `alarm()`.

Writes return `ready = (backfill.state === 'done')`.

### 3.6 Alarm

There is one alarm, set to the earliest of:
- `min(snoozed_until)`;
- `min(outbox.next_attempt_at)`;
- `min(pg_drift.next_attempt_at)`;
- now + 250 ms while a backfill, catch-up, reverse sync, rebuild, FTS trim or destroy is running.

`alarm()` runs, within a budget of about 20 s:
1. Destroy continuation (exclusive).
2. Snooze wake: the same rule as snooze.ts:166-182. Under object-only, an `entity_event` outbox row so clients refresh.
3. Outbox drain:
   - up to 500 `ledger.mail` rows go to the ledger as one `recordMailAddresses` call;
   - backoff `min(2^attempts × 5 s, 1 h)`; after 20 attempts the row stays and an error is logged;
   - `entity_event` rows go to `ENTITY_EVENTS`.
4. `pg_drift` mirror (object mode).
5. One page of backfill or catch-up.
6. FTS trim.
7. Set the next alarm.

After any write that adds outbox rows, the alarm is set to now + 1 s, so ledger updates are batched about once a second. Snooze, resnooze and unsnooze reschedule the alarm.

### 3.7 Size

- After `applyBatch` and backfill pages, and every 200 writes, read `ctx.storage.sql.databaseSize`.
- Above 6 GB: log `mailbox_store_size {level:'warn'}` at most daily.
- Above 8 GB: log an error and set `fts_trim_before = now − 2 years`. The alarm then deletes FTS rows of older messages in batches, and `status` reports `searchTrimmed`.
- `status()` returns `sizeBytes`, the message count and `sqlite_version()`.

### 3.8 `destroy(ref)`

1. Set `meta.destroying` (from then on writes throw `MAILBOX_DESTROYED`). Return `{accepted:true}` quickly.
2. The alarm then:
   - lists and deletes the R2 prefix `mail/<ws>/<acct>/` and every `attachments.storage_path`, 1000 keys per `bucket.delete([])`, keeping progress in `meta`;
   - calls `ledger.dropMailbox(accountId)`;
   - runs `deleteAlarm()` and `deleteAll()`.
3. Calling `destroy` again is a no-op that keeps going where it stopped.

### 3.9 Ledger mail index (`outbound/mail-index.ts`, used by `OutboundLedger`)

- **Tables** (in the ledger's SQLite through `ctx.storage.sql`, alongside its existing KV keys):
  - `correspondents(email PK, first_inbound_at, last_inbound_at, inbound_count, first_outbound_at, last_outbound_at, outbound_count, replied_after_first_contact)`;
  - `address_index(address, account_id, last_seen_at, message_count, PK(address, account_id))`;
  - `mail_meta`.
- **RPCs:**
  - `recordMailAddresses(batch)` (from mailbox outboxes);
  - `firstContacts(subject, recipients) → {authoritative, firstContact}`. Authoritative only when seeded and the workspace mode is `object-only` (the ledger reads Flagship);
  - `mailboxesForAddress(address)`;
  - `ensureCorrespondentsSeeded()` (alarm-paged copy of `mail_correspondents`);
  - `dropMailbox(accountId)`, `forgetMailData()`.
- **`commit`** also records outbound correspondents.
- **Guard changes:** `checkOutbound` calls `firstContacts` first and falls back to `firstContactsOf(db)` (guard.ts:361). The suppression check stays on Postgres. `recordOutboundCorrespondents` to Postgres stays until the drop PR.

## 4. Backfill and parity

**Backfill (object-driven, resumable).**
- **Triggers:**
  - `ensureBackfill` is called by the router on the first single-mailbox read in shadow or above (isolate-memoised);
  - by `POST /internal/mail-store/backfill {workspaceId, accountId?, force?}`;
  - and on account creation when mode ≥ shadow.
  - Never by a timer. The alarm only continues a backfill that is already running.
- **State** in `meta.backfill`: `{state: idle|running|catchup|done|failed, phase, cursor, startedAt, pgWatermark, copied, attempts}`.
- **Steps** (each alarm opens the tenant DB through `getTenantDbForWorkspace(env, workspaceId)`):
  1. `subscriptions`: every `mail_subscriptions` row of the account.
  2. `drafts`: live `mail_drafts` of the account.
  3. `messages`: pages of 200, `WHERE account_id=? AND (created_at,id) > cursor ORDER BY created_at, id`, plus their `mail_attachments`.
     - First put R2 bodies (`body.html`/`body.txt` from `html_body`/`text_body`; `raw.eml` when `raw_message` is not null).
     - Then, in one transaction, `applyPgRow(row, atts)`:
       - insert if absent;
       - otherwise overwrite the mutable groups when `pg.updated_at ≥ max(clk_*)`;
       - legacy normalisation folds `isStarred`/`isImportant`/`isTrash`/`isSpam` into labels, with location precedence TRASH > SPAM > ARCHIVE > INBOX;
       - derived tables are kept through `changeMessage`.
     - Write the cursor; queue one `ledger.mail` outbox row per page with the aggregated addresses.
  4. `catchup`: rows with `updated_at > pgWatermark − 5 min` (deleted rows included), paged by `(updated_at,id)`, through `applyPgRow`.
  5. `done`: call `ledger.ensureCorrespondentsSeeded()`; `ready=true`.
- **Errors:** backoff 1 / 5 / 30 min; after 10 attempts the state is `failed` and an error is logged.
- **Ongoing catch-up (shadow):** `catchUp(ref)` repeats step 4 from `meta.pg_sync_at`. The router triggers it at most every 10 minutes per mailbox, or immediately when `mbxdrift:` is set. It only runs on mailbox open, which in shadow mode reads Postgres anyway.
- **Postgres gaps to fix for catch-up:** `markSentCopy` (delivery-events.ts:144-147) and `persistClassification` (ai.ts) do not set `updated_at`. Hard deletes are invisible to catch-up: `sendScheduledNow` (scheduled.ts:416-417) and the fixtures reset. They are dual-written as `delete{hard}`, and full parity reports them.

**Full parity** (`POST /internal/mail-store/parity {workspaceId, accountId?, repair?}`, object-driven, alarm-paged):
- For each Postgres page `SELECT id, updated_at, labels, is_read, is_flagged, is_starred, is_important, is_trash, is_spam, deleted_at, COALESCE(thread_id,id), send_status, snoozed_until, delivery_status, attachment_count … WHERE account_id=? AND id>? ORDER BY id LIMIT 1000`, compare normalised row hashes with the object.
- It records `missing` / `extra` / `different` ids and a stats-and-counts comparison in `meta.last_parity`.
- Repair: in shadow, `applyPgRow`; in object mode, `pg_drift`.

**Reverse sync** (`POST /internal/mail-store/reverse-sync {workspaceId, since}`, required before any downgrade from `object` or `object-only`):
- Object rows with `updated_at ≥ since` are upserted into Postgres: missing rows are inserted with bodies from R2 into `text_body`/`html_body`, with attachments, subscriptions and drafts; mutable fields are updated.
- `rebuildDerived` truncates and rebuilds the derived tables in pages. `ready=false` meanwhile, so reads fall back.

## 5. Reads that span mailboxes

- **Composite cursor.** Every mailbox shares one total order, `(latestAt DESC, accountId ASC, threadKey ASC)`. A value-based cursor `t1.<base64url {latestAt,accountId,threadKey}>` is therefore exact: each mailbox returns its top `pageSize` after the cursor, and the merged top `pageSize` is correct.
  - This corrects the plan's "one position per mailbox".
  - Message lists use `m1.<base64url {sentAt,id}>`. A legacy bare-id cursor is located across mailboxes.
- **Unified inbox** (`listThreads(accountIds, q)`):
  - parallel `mailbox(a).listThreads({...q, limit: pageSize})`, k-way merge (`store/merge.ts`);
  - `totalCount` = Σ;
  - `nextCursor` is the last item if any mailbox had more;
  - offset mode fetches `offset + pageSize` from each mailbox (capped at 5000).
  - `/api/mail-labels/threads` adds an optional `cursor` query parameter and `nextCursor` to the response.
- **Unified stats:** field-wise sum of `stats()`.
- **Sidebar badge** (app-api `/sidebar-badges`): Σ `__all.unread` over `MailAccess.accessibleAccountIds()`.
- **CRM Emails tab:** `GET /api/mail-messages?counterparty=<email>` (new; the `search=` path still works as FTS).
  1. If the ledger's address index is seeded, take `mailboxesForAddress(address)` ∩ accessible accounts; otherwise all accessible accounts.
  2. Each mailbox runs `listMessages({counterparty, limit})` on `message_addresses`.
  3. Merge by `(sentAt, id)`.
  - The platform hook `useMailMessagesByCounterparty` (use-mail-queries.ts:189) switches to the new parameter.
- **CRM recent correspondents:** the crm-api route checks mailbox access, gets `recentAddresses(200)` from that mailbox's store, then calls `people.listPeopleForEmails(db, emails, limit)`. crm-domain no longer queries `mail_messages`.
- **Drive:**
  - `recentAttachments(accountIds, {limit: 2000 per mailbox})` + Σ `totalCount`, merged by `createdAt`;
  - `aggregateAllFiles` and `aggregateStats` keep their in-memory paging;
  - the mail `url` becomes the authenticated download route instead of the public `downloadUrl`.
- **External API and MCP without `accountId`:** the same fan-out over the principal's mailboxes (workspace keys: shared mailboxes only). Their opaque cursors change format in object modes; legacy `o:<offset>` is still decoded.
- **Locate** (`GET/PATCH/DELETE /mail-messages/:id`, attachments, drafts, bulk):
  1. If the optional `accountId` hint is in the accessible set, try that mailbox first.
  2. Then fan out `getMessages(ids)` to the rest.
  3. An isolate LRU (`ws:id → account`, 10k entries, 10 min) avoids repeats.
  - In object modes, a message outside the caller's reach is a 404, where today it is a 403 (no existence leak; external-api already does this).

## 6. Auth path without tenant queries

**KV mailbox directory** (`packages/core/db/src/lib/mailbox-directory-cache.ts` for the keys and the bump; `store/directory.ts` for reading and building):
- **Keys:** version `mbxdirv:<ws>`; entry `mbxdir:<ws>:<v>` holding `{v:1, builtAt, accounts: DirectoryAccount[], labels: Record<accountId, DirectoryLabel[]>}`.
- **Accounts:** every `mail_accounts` column except `accessToken`, `refreshToken`, `apiKey`, `passwordHash` and `providerConfig`; includes `isShared` and `assignedUserIds`.
- **Labels:** `id, name, slug, isSystem, color, position, aiEnabled`.
- **TTL** 7 days. Invalidation is by version bump, as for `permv`, so a cold open finds it warm.
- **On a miss:** one batched Postgres read (accounts + labels), then `put`.
- **`bumpMailboxDirectoryVersion(env, ws)` is called after:**
  - mail-api accounts.ts create / update / delete / assign;
  - weldmail.ts address creation;
  - sync.ts status changes;
  - labels.ts create / update / delete;
  - workspace-worker `ensureWorkspaceMail` and backfill-mail;
  - app-api fixtures.
  - Not after `sentToday` bumps: that field is stale in the directory by design.

**`MailAccess` in object modes:**
- `isAdmin` = `getPermissionsFromContext(c).role ∈ {OWNER, ADMIN}`, already resolved by `requirePermission`.
- `canOpen`, `canManage` and the accessible list use today's pure rules (`hasAccessToAccount`, `principalHasAccess`, `canManageAccount`) on directory data.
- `emailEventData` uses `isShared` from the directory.
- In `postgres` and `shadow` modes, `MailAccess` wraps today's access.ts unchanged.
- External API and MCP user principals take the role from `resolveEffectivePermissionsCached`; workspace keys get shared mailboxes only.

**Open path in object mode:**

| Request | Served from |
|---|---|
| `/mail-accounts` | directory |
| `/mail-labels?accountId` | directory + object `labelCounts` |
| `/mail-labels/threads` | object |
| `/mail-messages/stats` | object |
| `/mail-sending/usage` | ledger (master DB policy only) |

- **Sender names:** own-mailbox names come from the directory. Contact names and avatars from `people` run in parallel with the object read, and the list waits at most 150 ms (`MAIL_CONTACT_ENRICH_DEADLINE_MS`) before returning From-header names. An isolate LRU per `(ws, email)` holds results for 5 min.
- **Remaining prerequisite:** the permission cache TTL (§0.2).
- **Revocation window:** up to ~60 s of KV staleness across colos after unassigning a user. This is the same order as the permission cache. If that is unacceptable, host the directory in a per-workspace object.

## 7. Workspace deletion, export and database move

- **Workspace deletion** (`apps/workers/workspace-worker/src/routes/webhooks/clerk.ts:339-404`): after the soft-delete and before `deleteWorkspaceDatabase` (line 397), call `await destroyWorkspaceMail(env, masterDb, workspace.id)`. New file `services/workspace-mail-destroy.ts`:
  1. Mailboxes = `mail_account_registry` rows for `workspace_id` (any `isActive`; rows survive account soft-delete, accounts.ts:577-581) ∪ tenant `mail_accounts` including deleted ones (best effort while the DB exists).
  2. For each, `mailboxStub(env, ref).destroy(ref)`.
  3. Then the ledger `ws:<id>` `forgetMailData()`.
  4. If it throws, the webhook redelivers, so the DB teardown never runs ahead of the mail destroy.
  - The same idempotent call goes into `services/teardown-sweep.ts retryTeardown` (line 65) before `deleteWorkspaceDatabase`.
  - It runs in every mode: it is idempotent, and an object never used holds no data.
  - Mailbox account deletion (accounts.ts:566) stays a soft delete. The object is kept, as Postgres rows are today.
- **Export:** no workspace data export exists today (searched app-api and workspace-worker). Provide `exportPage` on the store, an `exportMailbox(env, ref)` async iterator (metadata pages + R2 body keys), and `GET /internal/mail-store/export?workspaceId&accountId&cursor&sentOnly&since&until`. outbound-audit and any future GDPR export use these.
- **Database move** (DATA-016, `lib/database-move/catalog.ts`): no change, since it copies whatever tables exist. Under object-only the mail tables stop growing; after the drop PR they are gone.
  - Follow-up: worker-kit `readOnly` with reason `database_move` (the licence gate) still blocks mail writes for object-only workspaces. Exempt mail-api writes for those later.

## 8. wrangler.toml changes

**mail-api (host)**, at top level and in `env.test` / `env.production`:

```toml
[[durable_objects.bindings]]
name = "MAILBOX_STORE"
class_name = "MailboxStore"

[[migrations]]          # append after outbound-v1
tag = "mailbox-v1"
new_sqlite_classes = ["MailboxStore"]

[vars]
MAILBOX_PARITY_SAMPLE_RATE = "0.05"
```

Admin routes reuse `OUTBOUND_ADMIN_SECRET`, extracted to `lib/admin-auth.ts`.

**Binders** (`script_name` = `weldsuite-mail-api-dev` at top level, `weldsuite-mail-api-test` in test, `weldsuite-mail-api` in production; the wrangler-config test enforces this):

| Worker | Add |
|---|---|
| mail-inbound-worker | `MAILBOX_STORE`; `[[env.test.flagship]]` app_id `d8c58a91-9e17-432b-b4e8-0f2c9959490e`, `[[env.production.flagship]]` `895f413b-8b8d-4e6f-bb14-399721deb17e` (it has none today) |
| external-api | `MAILBOX_STORE` (already has `FLAGSHIP`, `STORAGE`, `OUTBOUND_LEDGER`) |
| mcp-server | `MAILBOX_STORE` (already has `FLAGSHIP`, `STORAGE`) |
| app-api | `MAILBOX_STORE` |
| crm-api | `MAILBOX_STORE` |
| workspace-worker | `MAILBOX_STORE` + `OUTBOUND_LEDGER` |

Also add `MAILBOX_STORE?: DurableObjectNamespace<MailboxObject>` to each worker's `Env` type (`import type`). Add `wsId?: string` to `SEND_SCHEDULED_EMAIL` params (mail-api types.ts:47-53). Old instances resolve it with `getWorkspaceForOrg`.

**Flag:** add `'weldmail-mailbox-store': { type: 'string', default: 'postgres' }` to `packages/core/feature-flags/src/flags.ts`, and create it in both Flagship apps.

**Deploy order:** mail-api is in the `module-workers` job. Binders in that same matrix (crm-api) already retry on `code: 10061`. mail-inbound-worker, external-api, mcp-server, app-api and workspace-worker deploy in the `workers` job, which `needs: module-workers` (`.github/workflows/deploy.yml:681-735`). No pipeline change is needed. The order is mail-api, then everything else.

## 9. Work breakdown

Each task fits one specialist in one go. Tasks within a group touch disjoint files and can run in parallel. Size: S / M / L.

### Group A: start now, in parallel

- **A1 Test fakes (M).**
  - Files: `packages/core/worker-kit/src/testing/durable-sqlite.ts` (node:sqlite `SqlStorage`, cursor `toArray/one/raw/columnNames/rowsRead/rowsWritten/iterator`, `transactionSync`, KV API, alarms, `deleteAll`, `databaseSize`, `createSqliteDurableObjectState`, `fireAlarm`), `testing/r2.ts` (`createMemoryR2`: put/get with ranges/head/delete arrays/list with prefix and cursor), `package.json` exports.
  - The fake is strict, like workerd: it rejects BEGIN/COMMIT/SAVEPOINT, boolean and undefined bindings, and multi-statement strings.
  - Tests: `durable-sqlite.test.ts`, `r2.test.ts`.
- **A2 Mode, flag and directory primitives (S).**
  - Files: `feature-flags/src/flags.ts`, `domains/mail/src/store/mode.ts`, `db/src/lib/mailbox-directory-cache.ts`.
  - Tests: mode parsing and cache; version bump.
- **A3 Contracts and pure model (M).**
  - Files: `store/types.ts`, `store/model.ts` (`folderKeys`, label and move semantics extracted from labels.ts/messages.ts, `normalizeLegacy`, `applyRuleAction` moved from email-storage.ts:1727-1810, rule-condition evaluation, thread-match helpers moved from `mail-inbound-worker/src/lib/thread-match.ts` with a re-export left behind), `store/cursor.ts`, `store/merge.ts`, `store/fts-query.ts`, `store/thread-summary.ts` (moved from threads.ts:225-290).
  - Tests: model, cursor, merge, fts-query.
- **A4 R2 bodies and the raw MIME fix (S).**
  - Files: `store/bodies.ts`; `mail-inbound-worker/src/lib/cf-email-adapter.ts` (keep bytes) and the `raw.eml` put in email-storage.ts in every mode; `send.ts buildEmlAttachment` 948 reads R2 raw first; `isWorkspaceStorageKey` accepts `mail/<ws>/`.
  - Pre-flight: check the R2 bucket's jurisdiction.
  - Tests: bodies, `forward.test.ts` (eml from R2).
- **A5 Ledger mail index (M).** Depends on A1.
  - Files: `outbound/mail-index.ts`, `outbound/ledger.ts` (tables, RPCs, seeding, forget/dropMailbox, commit records outbound), `outbound/guard.ts` (`firstContacts` first).
  - Tests: `mail-index.test.ts`, `ledger.test.ts`, `guard.test.ts`.

### Group B: after A1 and A3

- **B1 Object schema and write core (L).**
  - Files: `mailbox-object/{schema,migrate,sql,writes}.ts`. Covers `ingest`, `flags`, `labels.*`, `move`, `delete`, `thread.*`, the derived tables, FTS and the outbox row.
  - Tests: migrate from every version; counts, threads and `thread_labels` invariants after each op (property test: random op sequences, then `rebuildDerived` must equal the incremental state).
- **B2 Remaining object ops (M).** Depends on B1.
  - Ops: snooze, `snooze.wake`, scheduled, `delivery.match`, `inbound.finalize`, categories, `label.rename`/`label.delete`, `folder.read` batching, attachments, drafts, subscriptions.
  - Same file as B1 or `writes-extra.ts`.
- **B3 Object reads (M).** Depends on B1. Parallel with B2.
  - File: `mailbox-object/reads.ts`.
  - Tests: fast and filtered paths, search, keyset and offset, stats map.
- **B4 Postgres store (L).** Depends on A3; rebase on phase 1. Parallel with B1–B3.
  - Files: `store/postgres/{mailbox-store,workspace-store,inbound,scheduled,subscriptions}.ts`; the access split and `now` parameters in threads.ts, messages.ts, labels.ts, snooze.ts, thread-ops.ts, attachments.ts, drafts.ts; the `updatedAt` fixes.
  - Tests: existing pglite suites stay green; new `postgres-store.test.ts`.

### Group C: after B

- **C1 Object class (M).** Depends on B1–B3 and A5 (types).
  - Files: `mailbox-object/{mailbox-object,alarm,outbox,destroy}.ts`, `index.ts`; the export in mail-api `src/index.ts`; mail-api `wrangler.toml` (all three envs) and `types.ts`.
  - Tests: RPC wiring, alarm multiplexing, outbox retry, destroy continuation (fakes).
- **C2 Object client and fan-out (M).** Depends on C1 types.
  - Files: `store/object/{stub,mailbox-store,workspace-store}.ts`.
  - Tests: merges, locate, offset cap.
- **C3 Router, parity sampler, access, factory (M).** Depends on B4, C2, A2.
  - Files: `store/{router,parity,access,directory,index}.ts`; mail-domain `package.json` exports.
  - Tests: the mode table, secondary failure isolation, demotion when not ready, parity diff, directory build and bump.
- **C4 Backfill, catch-up, full parity, reverse sync, rebuild + admin routes (L).** Depends on C1, B4.
  - Files: `mailbox-object/{backfill,parity,reverse-sync}.ts`; mail-api `routes/internal-mail-store/index.ts`, `lib/admin-auth.ts` (extracted from internal-outbound). Mount it in `src/index.ts` next to `/internal/outbound`.
  - Tests: pglite source + fake object, resume after a simulated eviction, LWW merge.
- **C5 Contract suite (M).** Depends on B4 and C2 (C1 for the real object).
  - File: `store/contract.test.ts`. Runs the scenarios ported from threads-listing, labels-locations, labels-archive, messages-stats, messages-spam, thread-filters-counts and thread-ops against both stores and asserts equal observable output.

### Group D: consumers, after C3; in parallel, one worker each

- **D1 mail-api write paths (L).**
  - Files: send.ts (all send helpers through the store); mail-api `services/mail/{scheduled,subscriptions,ai}.ts` and their routes; `workflows/send-scheduled-email.ts`; `outbound/delivery-events.ts` + queue.
- **D2 mail-api read and organise routes (L).**
  - Files: routes `mail-messages`, `mail-threads`, `mail-labels`, `mail-snooze`, `mail-attachments`, `mail-drafts`; `cron/snooze-sweep.ts`; `lib/read-push.ts`; `read-push.ts`.
  - Includes the `accountId` hints, `cursor`/`nextCursor`, `counterparty`, and fixes for `/mail-labels` without `accountId` and for `/mail-snooze/snoozed` scope.
  - Update the existing access tests: 403 → 404 in object mode.
- **D3 mail-api accounts and directory (M).**
  - Files: `services/mail/{accounts,weldmail,sync}.ts`, the mail-accounts routes. Directory-served reads; credential columns removed in every mode.
- **D4 mail-inbound-worker (M).** email-storage.ts through `createWorkspaceMail`, `inbound.finalize`, wrangler, `Env`.
- **D5 external-api + mcp-server (M).** The identical route copies, `lib/mail.ts` cursors, wrangler.
- **D6 app-api (M).** dashboard, drive-aggregation.ts, `_test-fixtures` (seed through `applyBatch`, reset), wrangler.
- **D7 crm and workflow (S).**
  - crm-api people route and the `people.ts` refactor with the access check.
  - Drop `mail_message` from both entity-tables files, entity-type-select.tsx:91 and the i18n entries (en/nl/es).
  - crm-api wrangler.
  - Audit how many workflows reference `entityType 'mail_message'` before merging.
- **D8 workspace-worker (S).** clerk.ts, teardown-sweep.ts, `services/workspace-mail-destroy.ts`, the directory bump in workspace-mail.ts and backfill-mail.ts, wrangler. Tests: `clerk.test.ts`, `teardown-sweep.test.ts`.

### Group E

- **E1 Platform client (M).** After D2.
  - Files: `app/weldmail/lib/api-client.ts` (`accountId` hints on message routes, bulk, add-to-messages), `hooks/queries/use-mail-queries.ts` (infinite threads by `nextCursor`, the counterparty hook).
  - Mobile hints are optional.
- **E2 outbound-audit store source (S).** After C4. Files: `tools/outbound-audit/src/{index,tenant-queries}.ts` + an export client.
- **E3 Optional workerd smoke test (S).** `@cloudflare/vitest-pool-workers` config for mail-domain: FTS5 `contentless_delete`/`detail=column` on workerd's SQLite, alarms, `evictDurableObject` mid-backfill.
- **E4 Docs (S).** The plan (phases 3–6 as built, corrections below), MAIL-009 (jurisdiction notes), the WeldMail design doc.

**Critical path:** A1/A3 → B1 → B3 → C1 → C2 → C3 → D*. B4 runs in parallel from the start of group B.

### Risks

- **Phase 1 is editing threads.ts, messages.ts, access.ts and snooze.ts concurrently.** B4, D1 and D2 must rebase.
- **The single-PR size.** The flag defaults to `postgres`; that guarantees no behaviour change only if every route keeps today's Postgres path verbatim in that mode. C5 and the existing pglite suites must stay green.
- **FTS index size against the 10 GB cap.** Start at 8 KB of body text, not 32 KB, with `detail=column`, and measure on the 50k seeded mailbox.
- **Search changes from substring ILIKE to token-prefix matching**, so "voice" no longer matches "invoice". Searches are excluded from parity.
- **SQLite version on workerd** for `contentless_delete` (needs ≥ 3.43). Check it in E3 or with `status().sqliteVersion` on test before turning on shadow.
- **`folder.read` on a huge folder** holds the object for seconds: up to 50 batches of 1000 within the 30 s DO CPU limit.
- **Clock skew** between Postgres `NOW()` writes (labels.ts:525, attachments.ts:202) and worker clocks under LWW. Full parity is the backstop.
- **Rollback from `object` or `object-only`** requires reverse sync. The runbook must say so, and the router logs a warning when it sees a downgrade.
- **Personal data outside the EU:** the ledger (§0.4) and possibly R2 (§0.5).

### Where the plan or ADR is wrong or incomplete

1. **The object table list lacks `message_addresses` and `drafts`.** Delivery-status matching, the CRM counterparty tab, recent correspondents and the To/From filters need the first. The stats drafts count reads `mail_drafts`, so drafts must move or the stats need Postgres.
2. **"No Neon on the mail open path" also needs:**
   - label definitions and account display data in the directory (`/mail-labels`, `/mail-accounts`);
   - a deadline on `people` enrichment;
   - a long-TTL permission cache (today 60 s).
3. **Ledger and EU:** the OutboundLedger is not EU-jurisdiction, contradicting MAIL-009's EU rule for correspondents and the address index.
4. **Unified cursor:** "one position per mailbox" is unnecessary. A value-based `(latestAt, accountId, threadKey)` cursor is exact.
5. **Phase 2's `body_key` and `search_text` columns** are superseded by deterministic R2 keys (the owner's decision). The plan text still lists them.
6. **Phase 3's routing list misses direct table access inside mail and other workers:**
   - mail-api scheduled.ts, subscriptions.ts and ai.ts;
   - route-level queries in mail-labels (52-67) and mail-messages (286-298);
   - the external-api and MCP bulk routes (172-175);
   - read-push.ts;
   - app-api test fixtures;
   - outbound-audit and the migrate-databases blob tools.
7. **Missing binder:** workspace-worker must also bind `MAILBOX_STORE` (and `OUTBOUND_LEDGER`) for deletion.
8. **Correspondent ingest:** "inbound ingest records the sender in the ledger" should go through the object's outbox, so it is transactional with the ingest. The 0214 trigger simply stops firing under object-only (no inserts); dropping it belongs to the drop PR.
9. **Existing bugs found** (fix them in D2/D3/D6/D7):
   - `GET /api/mail-accounts` returns credential columns;
   - `GET /api/mail-labels` without `accountId` lists private mailboxes' labels and counts;
   - `/api/mail-snooze/snoozed` without `accountId` lists every mailbox's snoozed mail (subject, from);
   - crm-api recent correspondents does not check mailbox access;
   - Drive returns mail attachments' public `downloadUrl`;
   - the workflow `mail_message` generic CRUD bypasses MAIL-003;
   - the thread list still flips scheduled mail to `sent` on read (threads.ts `buildExpireScheduledUpdate`).

### Critical files for implementation

- `E:\github\weldsuite\wt-mail-storage-plan\packages\domains\mail\src\threads.ts`
- `E:\github\weldsuite\wt-mail-storage-plan\packages\domains\mail\src\labels.ts`
- `E:\github\weldsuite\wt-mail-storage-plan\packages\domains\mail\src\outbound\ledger.ts`
- `E:\github\weldsuite\wt-mail-storage-plan\apps\workers\mail-inbound-worker\src\lib\email-storage.ts`
- `E:\github\weldsuite\wt-mail-storage-plan\apps\workers\mail-api\src\routes\mail-messages\index.ts`
- `E:\github\weldsuite\wt-mail-storage-plan\packages\core\worker-kit\src\testing\d1.ts`
