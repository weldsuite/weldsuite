# WeldChat: record chats in the sidebar

Companies, people, tasks, projects and domains each have their own chat (an
"entity channel", `chat_channels.type = 'entity'`). Today those conversations
only live on the record's panel. This plan brings them into WeldChat, the
platform and the mobile app, in a way that stays tidy when a user is in
hundreds of them.

Working name in the UI: **record chats**.

## Where things stand

| What | Where | Effect |
|---|---|---|
| Sidebar drops every entity channel | `apps/web/platform/app/weldchat/hooks/use-weldchat-sidebar-items.tsx:122`, `:640`, `:708-712`, `:932` | Record chats never show in WeldChat. Deliberate since commit `531322e15` (2026-09-03), which removed the earlier per-type groups and `lib/entity-channels/registry.ts`. |
| Mobile does the same | `apps/mobile/weldchat-app/app/(tabs)/index.tsx:184-187` | Same. `apps/mobile/weldchat-app/lib/entity-channels/registry.ts` is left over, unused, and has the old type names. |
| Sidebar loads only 25 channels | `hooks/queries/use-weldchat-queries.ts:415` calls `/channels` with no `limit`; `apps/workers/chat-api/src/routes/channels/index.ts:193` defaults to 25, newest first, DMs and entity channels included | **A bug today.** A user in more than 25 conversations loses their oldest channels (often `#general`) from the sidebar. Mobile already works around it with `limit: 100`. Showing record chats through this list would make it much worse. |
| Two code paths create record chats | Companies and people: crm-api `routes/{companies,people}/chat.ts` + `src/lib/entity-channel.ts` (types `company`, `person`). Tasks, projects, contacts, domains: chat-api provider registry `services/chat/entity-channels/` (types `task`, `project`, `contact`, `domain`) | The crm-api path sends no realtime events, no mention notifications and no `channel_new` push, so a new company chat would not appear in anyone's sidebar until a refresh. `company` and `person` have no chat-api provider, so `/api/chat-entity-channels/company/...` answers 400. |
| Stray type names | `components/customer-chat/customer-chat-panel.tsx:19` defaults to `customer`; old registries used `customer` / `contact` | Needs one canonical set: `company`, `person`, `task`, `project`, `domain`. |
| Access is membership only | `packages/domains/chat/src/channel-access.ts:27` (`canAccessChannel`): non-public channels need a `chat_channel_members` row | A company chat's members are its owner, account manager and whoever posted first; a person chat has only the first poster. A colleague who opens the record panel after that cannot read the chat (403) and is never added. ADR CHAT-003 says access should follow the record; the code does not. |
| Sections are workspace-wide | `chat_channels.sectionId`, `chat_sections` has no user column | Moving a channel into a section moves it for everyone (the design doc says "per-user"; it is not). Record chats should not use sections. |
| Per-group sidebar settings already exist | `app/weldchat/lib/group-filter.ts`, `GroupSettingsDialog`, stored per user in `uiPreferences.weldchatGroupFilters` | Top-N, sort, hide inactive, collapse, "peek" unread/mentions in a collapsed group, drag order. We reuse all of this. |
| Record panels exist for every type | `components/objects/{company,person,task,project,domain}` | A record chat in WeldChat can open the record next to the conversation. |

## Decisions

| Question | Decision |
|---|---|
| Who may **read** a record chat? | **Agreed 2026-10-25:** anyone who may see the record (matches ADR CHAT-003). Membership means "following", not "access". Opening the chat on the record panel works for every colleague with access; posting there follows it. Unfollowing removes it from the sidebar but keeps it readable on the record. (Rejected: membership-only with auto-join on open, which fills sidebars with every record someone glanced at.) |
| Which record chats show in my sidebar? | Proposed: only the ones I **follow**, not every record chat I could open. |
| What is "following"? | Proposed: having a `chat_channel_members` row. It drives the sidebar, unread state and notifications. No new table. |
| Who follows automatically? | Proposed: Company: owner, account manager, anyone who posts or is @mentioned. Person: anyone who posts or is @mentioned. Task: assignee and creator. Project: project members. Domain: whoever posts. |
| How are they grouped? | One sidebar group per record type, in a fixed order: Companies, People, Tasks, Projects, Domains. A group only appears when it has something in it. |
| Can record chats go into sections? | No. Sections are shared by the whole workspace. |
| Can you delete a record chat from WeldChat? | No. Delete stays on the record panel (owner/admin), so a sidebar click cannot wipe a customer's history. |

## How it stays organised with many chats

1. **Followed only.** The sidebar never lists "all companies with a chat".
2. **Grouped by type**, each group collapsible, with its own unread and mention
   counts on the header so a collapsed group still signals.
3. **Most recent first, top 5 per group**, then a "Show all (N)" row that opens
   the record chats page filtered to that type.
4. **Quiet chats drop out.** No message in 30 days and nothing unread: hidden
   from the sidebar, still on the record chats page and back as soon as
   someone writes.
5. **Collapsed groups peek**: unread chats and mentions still show under a
   collapsed header.
6. **Per-user control** through the existing group settings dialog: change
   top-N, sort order, the inactivity window, collapse by default, or hide a type
   entirely. Plus "Mute all" and "Unfollow" on each row.
7. **A full page for the long tail**: `/weldchat/records`, searchable and
   paginated, so nothing depends on the sidebar holding everything.

New group defaults (only for `record:*` group keys; regular channels and DMs
keep today's defaults):

```ts
{
  sortBy: 'recent',
  boostMentions: true,
  boostUnread: true,
  topN: 5,
  activityThreshold: '30d',
  peekActiveWhenCollapsed: true,
  peekUnread: true,
  peekMentions: true,
  hideWhenEmpty: true,
}
```

The 30-day filter must never hide a chat with unread messages or mentions.
`passesActivityThreshold` (`app/weldchat/lib/group-filter.ts:215`) only looks
at `lastMessageAt` today, so add that exemption (for record groups at least).

## Phases

### Phase 0: fix the 25-channel cap (do first, ships on its own)

- `chat-api` `GET /api/channels`: accept a `types` filter (comma list), so the
  sidebar asks for `types=public,private` and DMs and record chats can no longer
  push channels out of the page.
- Platform `useChannels`: request `limit=100&types=public,private`. Follow the
  cursor if `hasMore` (rare, but then nothing silently disappears).
- Mobile `appApi.channels.list`: same `types` filter.
- Tests: route test with more than 25 memberships, mixed types.

### Phase 1: one backend path for record chats

- Register `company` and `person` providers in chat-api
  (`services/chat/entity-channels/providers/`), with the same display-name and
  default-member logic as crm-api's `loadCompanyInfo`. Retire the `contact` and
  `customer` names (check tenant data for existing `contact` / `customer` rows
  first; rename them to `person` / `company` with a one-off script if any exist).
- crm-api `/companies/:id/chat/*` and `/people/:id/chat/*` keep their paths
  (weldcrm-app uses them, `services/record-tabs.ts`) but forward to chat-api
  over a new `CHAT_API` service binding. This is the `ChatRpc.ensureEntityChannel`
  step the module split plan already names. Delete `crm-api/src/lib/entity-channel.ts`
  and its copy of `entity-activity.ts`; chat-api's `postChatMessage` already
  mirrors the message into CRM activity, sends realtime events and
  notifications.
- On create, on auto-follow and on a mention that adds a follower, publish
  `channel_new` on each new follower's user topic so the sidebar updates live.
- Access (decided, see above): `canAccessChannel` for
  `type = 'entity'` asks the provider (`canAccess` plus the workspace permission
  for that type, such as `companies:read`) instead of membership. Providers get
  a `requiredPermission` for every type, checked in that path, not only in the
  route. Posting auto-follows. This is the security-sensitive part: give it
  its own PR and tests (non-member reads, member who lost CRM access, guest,
  deleted record).
- New list endpoints under the existing `/api/chat-entity-channels` prefix (no
  `api-modules` change needed):
  - `GET /api/chat-entity-channels?type=&filter=following|unread|mentions|all&search=&cursor=&limit=`:
    record chats with the caller's state (`isMuted`, `lastReadAt`,
    `unreadMentionCount`), ordered by `lastMessageAt desc, id desc`, cursor
    paginated. `all` lists every record chat the caller may read (for the
    records page); the sidebar uses `following`.
  - `GET /api/chat-entity-channels/summary`: per type, followed count, unread
    count and mention count, for the group headers. Mount it before
    `/:entityType`.
  - Both skip types the caller has no permission for and records that are
    deleted (a batch `filterVisible(ids)` on each provider, so a deleted
    company's chat never lingers in the sidebar).
  - Replaces the current `GET /:entityType`, which loads every membership into
    memory and returns no unread state.
- `POST /api/chat-entity-channels/:type/:id/follow` and `DELETE …/follow`.
- Keep `entityDisplayName` in step with the record: refresh it when the record
  is renamed (entity-event consumer on `company.updated` / `person.updated` /
  `task.updated` …), or at least when the chat is opened.

### Phase 2: platform sidebar and chat view

- New `useRecordChats(type)` (infinite query on the list endpoint) and
  `useRecordChatSummary()` in `hooks/queries/use-weldchat-queries.ts`. Patch
  their caches from the same user-topic events that patch channels today
  (new message, read, mute, `channel_new`).
- Bring back a small client registry `app/weldchat/lib/record-chat-types.ts`:
  type, label key, icon, and how to open the record panel. One place, used by the
  sidebar, the header and the records page.
- `use-weldchat-sidebar-items.tsx`: after DMs and before the sections, add one
  group per type with key `record:<type>`, built with the existing
  `applyFilterAndSort`, `applyPeekFilter`, `isCollapsed`,
  `makeReorderHandler` and `makeSettingsAction`. Rows: record avatar (company
  logo, person photo) or type icon, display name, bold when unread, mention
  badge, muted badge. Row actions: Mute, Open record, Unfollow, Settings. No
  "Move to section", no Delete. Last row "Show all (N)" when the group is cut
  off. Group menu: Mute all, Settings, Hide this group.
- Route `/weldchat/<channelId>` for a record chat: header shows the type icon
  and display name (no `#`), a subtitle like "Company · owner Jane", an "Open
  company" button that opens the record's object panel next to the chat, and
  Follow / Unfollow. Breadcrumb `Companies › Acme`. Files:
  `app/weldchat/components/channel-header.tsx` (currently draws `Hash` / `Lock`
  only) and `app/weldchat/channel/page.tsx`.
- The record panel chat (`components/objects/_shared/object-chat.tsx`,
  `entity-chat.tsx`) gets an "Open in WeldChat" link and a Follow toggle.
- Quick switcher / channel search includes followed record chats, labelled
  with their type.

### Phase 3: record chats page

- `/weldchat/records` (route wrapper in `src/routes/weldchat/records/`, page in
  `app/weldchat/records/page.tsx`), built on `EntityList` like Directories.
- Type tabs (All, Companies, People, Tasks, Projects, Domains), filters
  (Following, Unread, Mentions, All I can see), search by name, newest activity
  first, infinite scroll.
- Row: avatar, name, last message preview, time, unread dot; actions Follow /
  Unfollow, Mute, Open record.
- Linked from each group's "Show all" row and from a "Record chats" entry in the
  sidebar's top navigation (next to Activity, Drafts, Directories, Saved items).

### Phase 4: mobile weldchat-app

- Replace the leftover `lib/entity-channels/registry.ts` with the canonical
  types.
- Home tab: the same per-type groups (top 5, "Show all"), from the same
  endpoints.
- A records list screen with the same filters.
- Record chat screen: header with type and an "Open in WeldCRM / WeldFlow" deep
  link where those apps are installed.

### Phase 5: docs

- Amend ADR CHAT-003 (or supersede it with CHAT-006) in
  `weldsuite-documentation`: record chats appear in WeldChat for followers,
  following is membership, reading follows the record, one provider per type
  including `company` and `person`.
- `design/modules/weldchat.md`: sections are workspace-wide, not per user; add
  the record chats sidebar and page. `design/modules/weldcrm.md`: remove the
  "no realtime" gap once Phase 1 lands.

## i18n

New strings, `en` and `nl`: group labels (Companies, People, Tasks, Projects,
Domains), "Record chats", "Show all ({count})", Follow, Unfollow, "Open
company / person / task / project / domain", "Open in WeldChat", the records
page filters, empty states and "Hide this group".

## Database

No new tables or columns. Following reuses `chat_channel_members`. One optional
index if the list query is slow on large tenants:
`chat_channels (type, entity_type, last_message_at desc) where deleted_at is null`.
That needs a migration, so ask first.

## Tests

- chat-api (pglite harness): list and summary endpoints (pagination,
  ordering, per-type permission filtering, deleted records left out), follow and
  unfollow, `canAccessChannel` for record chats, the `types` filter on
  `/channels`.
- crm-api: the forwarded company and person routes still create, post and log
  CRM activity.
- Platform: sidebar grouping, top-N plus "Show all", inactive chats hidden but
  unread ones kept, collapsed peek.
- Playwright: post in a company chat from the record panel and see it appear in
  the Companies group live, open it from WeldChat, open the company panel from
  the header.

## Out of scope

- Record chats for other objects (tickets, deals, orders). The provider
  registry makes each one a small follow-up.
- Per-user sections (would fix the shared-sections surprise for regular
  channels too, but is its own change).
- Merging record chats into the Activity feed beyond what mentions already do.
