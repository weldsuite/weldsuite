# WeldMail on the external API

Public `/v1` routes for WeldMail on `external-api` (`api.weldsuite.org`, `wsk_` keys and `wsat_` app tokens), with the same surface brought to `mcp-server`.

**Status (2026-10-07): implemented, phases 0–5.** The sections below are the plan as agreed. Where the build differs, see [As built](#as-built) at the end.

## Decisions

| Topic | Decision |
|---|---|
| Surface | Read, organize, drafts and send, all in v1 |
| Mailbox access | Personal keys follow the owner's normal mailbox access. Workspace keys (`wsk_`, no user) and app tokens (`wsat_`) reach **shared mailboxes only** |
| Scopes | One scope pair per object, like every other v1 resource, plus a separate `mail_messages:send` |
| Wildcards | `mail_messages:*` and `*` do **not** grant `mail_messages:send`. Send must be granted by name |
| Who can send | API sends only from accounts on a **verified WeldMail domain**. Other accounts get 422 |
| Daily send limit | Enforced for API sends (429 once `dailySendLimit` is reached). The WeldMail UI is unchanged |
| Compose attachments | Separate upload endpoint. Upload first, then reference the returned ids |
| Schema | One tenant migration in Phase 3 (pending uploads + sending key id). You approve the generated migration before it's committed |
| Scheduled send | Deferred to v2 |
| Code reuse | Move mail-api's pure services into `@weldsuite/mail-domain`. mail-api, external-api and mcp-server all import them |
| MCP | Read, organize and drafts in `mcp-server`, built on the same shared services. **No send tools**: a human still presses send in WeldMail |

## What exists today

- **mail-api** (`apps/workers/mail-api`) has the full logic. Its services in `src/services/mail/*.ts` are pure `(db, args)` functions. Only attachment delete and scheduled send take `env`.
  - Organize: `messages.updateMessage`, `bulkUpdateMessages`, `addMessageLabels` / `removeMessageLabels`, `softDeleteMessage`.
  - Move/archive/trash/spam: `labels.moveMessagesToLocation`, reached through `bulkAddLabelToMessages`.
  - Threads: `markThreadRead` (thread-ops.ts) and `listThreadsByLabel` (threads.ts).
  - Drafts: CRUD in drafts.ts.
- **`@weldsuite/mail-domain`** already holds `access.ts` and `send.ts`:
  - `access.ts`: `checkAccountAccess`, `userAccessCondition`, and `emailEventData`, which strips subject/from/to from event payloads for private mailboxes.
  - `send.ts`: `sendAndPersist`, `replyAndPersist` and `forwardAndPersist`, which validate, send through the `SEND_EMAIL` binding, store the SENT copy, stitch the thread and upsert contacts.
- **mcp-server** has read routes for `mail-{accounts,messages,labels,drafts}`, plus create for labels and drafts, in `src/api/routes/v1/`. They are written in its own SQL and use a ported copy of the access check (`src/api/lib/mail-access.ts`). Its `src/api/` folder is a copy of external-api's `src/`, apart from `scopes.ts`: mcp-server maps scopes to the caller's effective permissions.
- **external-api** has no mail routes and no mail scopes yet. It already has `STORAGE` (the same R2 bucket as app-api), `ENTITY_EVENTS` and `REALTIME`.
- **Behavior the API inherits:**
  - Changing a flag is local only. Nothing syncs back to IMAP, Gmail or Graph.
  - Every account sends through the Cloudflare binding with `from = account.email`, whatever its provider.
  - There is no permanent delete. `DELETE` sets `deletedAt`.
  - There is no send-draft endpoint today.

## Phase 0: shared foundation (`@weldsuite/mail-domain`)

This is one PR. mail-api's behavior must not change.

1. **Mail principal.** Add `MailPrincipal = { kind: 'user'; userId } | { kind: 'workspace'; keyId }` to `access.ts`, plus principal-aware versions of the existing helpers: `principalAccessCondition`, `checkPrincipalAccess` and `accessibleAccountIds`.
   - `workspace` matches `isShared = true` only.
   - The current `userId` signatures become thin wrappers, so mail-api call sites keep compiling.
   - Note: external-api sets `c.set('userId', session.userId ?? session.keyId)`. Mail routes must build the principal from `apiSession`, never from `userId`.
2. **Move services.** Move these from `apps/workers/mail-api/src/services/mail/` into new mail-domain modules, and add each one to `exports` in `package.json`:
   - `messages` (list, get, update, bulk, labels, soft delete, `getThread`)
   - `labels` (CRUD, add/remove on messages, `moveMessagesToLocation`, `applyLabelToThread`)
   - `folders`
   - `drafts`
   - `threads` (`listThreadsByLabel`, `markThreadRead`)
   - read-only attachment helpers

   Each service takes a `MailPrincipal` where it scopes accounts. mail-api's routes switch to the package imports, and its tests move or re-point.
3. **Send path changes** (`send.ts`):
   - `sendAndPersist`, `replyAndPersist` and `forwardAndPersist` accept a `MailPrincipal`. A workspace principal gets `createdBy = null`, plus the key id recorded somewhere auditable; check which column fits.
   - New `SendOptions.enforceDailyLimit`. When set, check `sentToday` against `dailySendLimit`, rolling the counter over on a new day, before sending. Throw `MailSendError('DAILY_LIMIT_REACHED')` when the limit is hit. mail-api does not set the option.
   - `idempotencyKey` also works for reply and forward. Today only compose has it. Check that the unique index covers SENT copies created by reply and forward.
   - New `sendDraftAndPersist(principal, draftId, opts)`: send through `sendAndPersist` with the draft's fields, then soft-delete the draft. If the send fails, the draft stays.
4. **Threads.** `listThreadsByLabel` pages by `page`/`pageSize`. Add a keyset variant ordered by `(latestSentDate, threadKey)` so the public API can return cursor pagination. Add `getThreadByKey(accountId, threadKey)`. A thread key is `COALESCE(threadId, id)`.

## Phase 1: external-api read routes

New files in `apps/workers/external-api/src/routes/v1/`, mounted in `v1/index.ts` and added to the `endpoints` list there.

**Named-only scopes.** In `src/lib/scopes.ts`, add a `NAMED_ONLY_SCOPES` set holding `mail_messages:send`. `hasScope` grants these only on an exact match, so `*` and `<namespace>:*` skip them. Test that no other scope's behavior changes.

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/v1/mail-accounts` | `mail_accounts:read` | Explicit column projection. Never `accessToken`, `refreshToken`, `apiKey` or `passwordHash` (port `publicAccount` from mcp-server) |
| GET | `/v1/mail-accounts/:id` | `mail_accounts:read` | 404 for an account outside the principal's access, never 403 |
| GET | `/v1/mail-messages` | `mail_messages:read` | Filters: `accountId`, `label`, `threadId`, `search`, `from`, `isRead`, `isStarred`, `hasAttachments`, `includeTrash`, `includeSpam`. Ordered by `sentDate`. Headers only, no body |
| GET | `/v1/mail-messages/:id` | `mail_messages:read` | Includes `textBody` and sanitized `htmlBody`. Never `rawMessage` |
| GET | `/v1/mail-threads` | `mail_messages:read` | `accountId?`, `label` (default `inbox`), search filters. Cursor pagination |
| GET | `/v1/mail-threads/:threadKey` | `mail_messages:read` | `?accountId=` required. Messages in order |
| GET | `/v1/mail-labels`, `/:id` | `mail_labels:read` | System labels included, marked `isSystem` |
| GET | `/v1/mail-folders`, `/:id` | `mail_folders:read` | |
| GET | `/v1/mail-messages/:id/attachments` | `mail_attachments:read` | Metadata |
| GET | `/v1/mail-attachments/:id/download` | `mail_attachments:read` | Streams from R2 with `no-store` and `nosniff` headers, same as mail-api |

**Every list query is scoped to the principal's accounts, including when `accountId` is left out.** Several mail-api lists don't do this today; that is filed as a separate task. When there are no reachable accounts, the condition is `sql\`false\``.

## Phase 2: organize, labels, folders, drafts

| Method | Path | Scope |
|---|---|---|
| PATCH | `/v1/mail-messages/:id` (`isRead`, `isStarred`, `isFlagged`, `isImportant`) | `mail_messages:write` |
| POST | `/v1/mail-messages/:id/labels` `{ add?: [], remove?: [] }` | `mail_messages:write` |
| POST | `/v1/mail-messages/:id/move` `{ location: inbox \| archive \| trash \| spam }` | `mail_messages:write` |
| POST | `/v1/mail-messages/bulk` `{ ids (≤100), action }` | `mail_messages:write` |
| DELETE | `/v1/mail-messages/:id` (soft) | `mail_messages:write` |
| POST | `/v1/mail-threads/:threadKey/read`, `/v1/mail-threads/:threadKey/labels` | `mail_messages:write` |
| POST/PATCH/DELETE | `/v1/mail-labels` | `mail_labels:write` |
| POST/PATCH/DELETE | `/v1/mail-folders` | `mail_folders:write` |
| GET/POST/PATCH/DELETE | `/v1/mail-drafts` | `mail_drafts:read` / `mail_drafts:write` |

- Every mutation publishes an entity event: `email/updated`, `email/deleted`, `mail_label/*`, `mail_folder/*` or `mail_draft/*`. Every `email` payload goes through `emailEventData`, bulk included (mail-api's bulk route skips it today).
- Location names are case-insensitive (`inbox` maps to `INBOX`), same as mcp-server's `normaliseLabel`.
- Document that these changes stay in WeldSuite and are not written back to Gmail/IMAP.

## Phase 3: attachments upload and send

**Migration (approval gate).** One tenant migration, generated with `pnpm --filter @weldsuite/db db:generate` only after you approve the schema diff:
- `mail_attachments.messageId` becomes nullable, plus `expiresAt` for pending uploads. Skip this if the column is already nullable.
- `mail_messages.sentByApiKeyId` (`varchar(30)`, nullable): which key sent a SENT copy when there is no user. Use the existing column instead if one fits.

**Bindings** for `external-api` (`wrangler.toml` in all three envs, plus `Env` in `src/types.ts`):
- `[[send_email]] name = "SEND_EMAIL"`. Cloudflare requires the sender to be verified per env, so reuse mail-api's setup.
- `WORKSPACE_CACHE` KV (the MX cache). Bind mail-api's namespace ids so the cache is shared.
- `R2_PUBLIC_URL` var (contact avatars).
- `CLOUDFLARE_API_TOKEN` if `@weldsuite/worker-email` needs it. Add to `scripts/secrets/manifest.ts`.

**Upload**

| Method | Path | Scope |
|---|---|---|
| POST | `/v1/mail-attachments` | `mail_attachments:write` |

- The body is the raw file, with `Content-Type` and a `?filename=` query param; a multipart form also works.
- Cap at 5 MiB, the send path's total cap.
- Writes to R2 under `workspaces/{orgId}/mail-uploads/{ts}_{rand}/{name}`. `send.ts` requires the `workspaces/{orgId}/` prefix; check which id `orgId` is in external-api's session.
- Returns `{ id, filename, contentType, size, expiresAt }`. Store it as a pending `mail_attachments` row with no message. Check the schema allows that; a migration needs approval first.
- Unused uploads expire after 24h via a sweep on an existing cron.

**Send**

| Method | Path | Scope |
|---|---|---|
| POST | `/v1/mail-accounts/:id/send` | `mail_messages:send` |
| POST | `/v1/mail-messages/:id/reply` (`replyAll?`) | `mail_messages:send` |
| POST | `/v1/mail-messages/:id/forward` (`excludeAttachmentIds?`, `asAttachment?`) | `mail_messages:send` |
| POST | `/v1/mail-drafts/:id/send` | `mail_messages:send` |

- **Sender domain check.** New `SendOptions.requireVerifiedDomain` in `send.ts`, always set by external-api. The domain of `account.email` must match a `mail_domains` row in this workspace with a verified status. Otherwise `MailSendError('SENDER_DOMAIN_NOT_VERIFIED')`, mapped to 422. For forward and reply, the check runs on the sending account, not the original sender. `GET /v1/mail-accounts` shows `canSendViaApi` so callers can see this in advance.
- Bodies take `attachmentIds: string[]`. The route resolves those to `fileKey` values and rejects ids from another workspace.
- An `Idempotency-Key` header (≤64 chars) maps to `idempotencyKey`. A replay returns the original result with `200`.
- `enforceDailyLimit: true` is always set. `DAILY_LIMIT_REACHED` returns 429 with `Retry-After` set to the next UTC midnight.
- Error mapping: `INVALID_RECIPIENTS` → 422 with details, `EMAIL_TOO_LARGE` → 413, `ACCOUNT_NOT_FOUND` / `FORBIDDEN` → 404, `*_BINDING_MISSING` → 503.
- Events: `email/email_sent` and `email/reply_sent`, payloads through `emailEventData`.

## Phase 4: mcp-server parity

- Delete `src/api/lib/mail-access.ts` and the hand-written SQL in `src/api/routes/v1/mail-*`. Rebuild those routes on the mail-domain services, matching external-api's paths. MCP callers always have a user, so they use a `user` principal.
- Scope names stay on the permission catalog (`messages:read|write`, `accounts:read`), because mcp-server checks effective permissions, not key scopes. No send permission is needed: MCP has no send.
- Add tools to `src/tools/mail/index.ts`:
  - `list_mail_threads`, `get_mail_thread`
  - `update_email`, `move_email`, `label_email`
  - `update_mail_draft`, `delete_mail_draft`
  - `list_mail_folders`, label update/delete
- **No send tools.** Don't mount the send, reply, forward, draft-send or upload routes in mcp-server's `src/api/`. Add a registry test that fails if any tool's path matches `/send`, `/reply` or `/forward`, so a send tool can't slip in later.
- Rewrite the header comment in `mail-messages/index.ts`. The "provider routing" it describes does not exist. The reason drafts-only holds is that sending stays with a human.

## Phase 5: client surfaces and docs

- **API key UI** (`apps/web/platform/components/settings/api-keys-section.tsx`): add a WeldMail group with every scope above. The file's own rule says every enforced scope must be listed there. Mark `mail_messages:send` as sensitive.
- **WeldApps** (`packages/core/i18n/src/locales/{en,nl}/weldapps.ts`): add consent labels for every mail scope.
- **App SDK** (`packages/sdk/app-sdk/src/core/api.ts`): add typed wrappers for the new endpoints, keeping the docstring scope notes.
- **API docs** (`apps/web/api-docs`):
  - one page per resource (`mail-accounts`, `mail-messages`, `mail-threads`, `mail-labels`, `mail-folders`, `mail-drafts`, `mail-attachments`)
  - a "Sending mail" guide covering idempotency, limits, attachments, shared-mailbox rule and no provider write-back
  - scope list in `authentication/page.mdx`
  - `Navigation.tsx` entry
  - changelog entry

## Tests

- **external-api** (pglite harness in `src/test/`): seed one shared and one private mailbox, then check:
  - Workspace key: sees only the shared one, gets 404 on the private one, including through lists without `accountId` and through threads.
  - Personal key of a member assigned to the private mailbox: sees it. A non-assigned admin does not, when assignees exist.
  - App token: same as workspace key.
  - Scopes: every route returns 403 without its scope. `mail_messages:write`, `mail_messages:*` and `*` cannot send; only `mail_messages:send` can.
  - Send, with `SEND_EMAIL` stubbed via `@weldsuite/mail-domain/testing`:
    - an idempotent replay returns the original result
    - 429 once the limit is reached
    - 422 from an account on an unverified domain or a Gmail account
    - cross-workspace `attachmentIds` are rejected
    - draft-send deletes the draft only when the send succeeds
  - Credential columns never appear in any response; check with a key scan on the JSON.
- **mail-domain**: unit tests for the principal conditions and `enforceDailyLimit`, including the day rollover.
- **mail-api**: the existing suites still pass after the service move.
- **mcp-server**: tool registry tests for the new tools.
- If `contract.test.ts` checks the endpoints list or docs, update it.

## Order and PRs

1. Phase 0 (mail-domain + mail-api switch). Biggest risk, no new public surface.
2. Phases 1 and 2 (read, organize, drafts on external-api).
3. Phase 3 (upload + send + bindings).
4. Phase 4 (mcp-server).
5. Phase 5 (docs, UI, SDK). Can go along with 2–4.

## To verify during implementation

- Which id `orgId` is in `send.ts`'s `workspaces/{orgId}/` key check, and which value external-api's session holds for it.
- That a personal key's `userId` is the same id as `workspace_members.userId`, which the access checks compare against.
- Which `mail_domains` status counts as verified, and whether subdomains count.

## Separate fix (filed as its own task)

Several mail-api lists (drafts, scheduled, folders, labels, `/stats`) return every mailbox's rows when `accountId` is left out, private mailboxes included. This is independent of this plan, but Phase 0 moves the same services, so land that fix first or together.

The moved services now take an optional `accessibleAccountIds` scope (drafts, labels, folders), which the v1 routes always pass. mail-api does not pass it yet; that is the fix above.

## As built

Where the implementation differs from the plan above, and why.

- **No migration.** `mail_messages` has no user column at all (platform sends do not record the sender either), and the entity event already carries the actor (`userId` is the key id for a workspace key). Pending uploads keep their filename and type as R2 object metadata, so they need no table row. The approval gate in Phase 3 never came up.
- **Uploads** live at `workspaces/{clerkOrgId}/mail/uploads/{mupl_id}/{file}` (`@weldsuite/mail-domain/uploads`). The id is pattern-checked before it becomes part of a key, so an id can only resolve inside the caller's own workspace prefix. There is no 24h expiry: once sent, the object is the sent copy's attachment and must stay. Uploads that are never sent stay in the bucket; a cleanup sweep is a follow-up.
- **Org id.** R2 keys and the send path use the Clerk org id, while the API session's `workspaceId` is the master id. The auth middleware now carries `clerkOrgId` on the session (cached with the workspace details); a session from an older cache entry falls back to `resolveClerkOrgId`.
- **Threads** page by an opaque offset cursor, not a keyset: the listing groups messages into threads, which a keyset cannot follow cheaply. `listThreadsByLabel` gained an `offset` input; `getThreadByKey` reads one thread.
- **System labels** are not rows in `/v1/mail-labels`; they are fixed names that every filter accepts (`inbox`, `trash`, …).
- **A body is required.** Send and reply return 400 without `body` or `htmlBody` (the MIME builder cannot build an empty message), and draft-send returns 422 `EMPTY_BODY`.
- **Draft-send** uses the draft's `attachmentIds` as upload ids unless the request passes its own. Drafts created in the WeldMail UI with attachments from its own upload flow are not sendable through the API with those attachments.
- **Daily limit** is counted live from the SENT copies since UTC midnight (`countSentToday`), because `sentToday` has no reset job. Concurrent sends can go a few over the limit.
- **Messages** also take `from` and separate `includeTrash` / `includeSpam` flags (the MCP tools used both), and `GET /:id?includeHtml=false` returns the text body only.
- **mcp-server** got a minimal vitest setup for its guard test (`src/tools/mail/mail.test.ts`), which fails if any tool or mounted route sends, replies, forwards or uploads. The shared route files and `lib/mail.ts` are byte-identical in both workers.
- **external-api tests.** The pglite helper (`src/test/pglite.ts`) was behind worker-kit's copy and crashed on the `vector` migration, so no pglite-backed external-api test ran. It now mirrors worker-kit again. That surfaced older failures unrelated to mail (accounting / knowledge-spaces / social-posts CRUD round-trips, and social-publish when run with the other files because of the shared module cache), filed separately.
