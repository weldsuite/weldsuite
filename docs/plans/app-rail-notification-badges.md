# App rail notification badges

Bring the red count badges back on the app icons in the platform's left app rail.

## What is there today

- **Data is still fetched.** `useSidebarBadges()` (`apps/web/platform/hooks/use-sidebar-badges.ts`)
  calls `GET /api/dashboard/sidebar-badges` (`apps/workers/app-api/src/routes/dashboard/index.ts`)
  every 60s (idle-aware) and returns `{ mail, helpdesk, calendar }`.
  `breadcrumb-header.tsx` calls the hook only to keep the query warm; nothing
  on desktop reads the result.
- **The desktop rail renders no badge.** `apps/web/platform/components/app-sidebar-client.tsx`
  shows only the `BetaBadge`. There is no badge code in it anywhere in the
  public git history, so the desktop badges were lost before 2026-07-23 or in
  a rail that was replaced.
- **The mobile rail still has them.** `components/layout/mobile-sidebar.tsx`
  has `getBadgeCount()`, `railBadgeSizeClass()` and the red pill markup.
- **One mapping is wrong.** The endpoint's `pendingOrders` (WeldCommerce) is
  stored as `calendar` in the hook and shown on the **WeldConnect** icon on
  mobile.
- **Chat has its own counter.** `useChatActivityUnread()` (`GET /chat-activity/unread-count`
  on chat-api) is already used inside WeldChat's own sidebar.

## Decisions

| App | Badge counts | Source |
|---|---|---|
| WeldMail | Unread messages in the mailboxes the member can open, trash/spam excluded | `sidebar-badges.unreadMessages` |
| WeldDesk | Open tickets in the workspace (unchanged) | `sidebar-badges.openTickets` |
| WeldChat | Unread chat activity (mentions, DMs, replies) | `chat-activity/unread-count` |

No badge for WeldCommerce or WeldConnect. Style: the mobile red pill with the
count, capped at `99+`, top-right of the icon. Hidden when the count is 0.

## Steps

### 1. One shared badge component

New `apps/web/platform/components/layout/app-rail-badge.tsx`:

- `AppRailBadge({ count })` renders nothing for `count <= 0`, otherwise the red
  pill (`99+` above 99). Move `railBadgeSizeClass()` and the pill classes over
  from `mobile-sidebar.tsx` unchanged.
- `aria-label` with the count (new i18n key, en + nl, e.g.
  `navigation.unreadBadge: "{count} unread"`), `pointer-events-none` so it never
  steals the click or the drag.

### 2. One hook that maps counts to app codes

Extend `use-sidebar-badges.ts` (or add `useAppRailBadges()` next to it) so both
rails ask one question, "what is the badge for this `appCode`?":

- Rename the internal field `calendar` to `orders` (it was always pending
  orders) and stop mapping it to any app.
- Add WeldChat by reading `useChatActivityUnread()`. It shares the query key,
  so WeldChat's own sidebar and the rail make one request between them.
- Return `getBadgeCount(appCode): number | undefined` keyed on the real app
  codes `weldmail`, `welddesk`, `weldchat`.

### 3. Render it on the desktop rail

In `app-sidebar-client.tsx`:

- Call the hook once in `AppSidebarClient`.
- Pass `badgeCount` into `SortableAppItem` and render `<AppRailBadge>` next to
  the `BetaBadge`. Do the same in the static pre-mount branch.
- Positioning: the apps list is `overflow-x-hidden` (scrolling rail). The rail
  is 60px wide and the icon 46px, so a badge at `-right-[3px]` stays inside the
  7px side margin and is not clipped. Check the first icon at the top of the
  scroll area (`py-1`) and adjust `-top` if it gets cut.
- Leave the badge out of the `DragOverlay` copy of the icon.

### 4. Switch the mobile rail to the shared pieces

In `mobile-sidebar.tsx`, replace the local `getBadgeCount`, `railBadgeSizeClass`
and pill markup with the hook and `AppRailBadge`. This also removes the
pending-orders badge from the WeldConnect icon.

### 5. Keep the counts fresh

- Polling stays at 60s, idle-aware.
- Already there: `decrementHelpdeskBadge()` on reading a conversation.
- Add: invalidate the sidebar-badges query when a mail message is marked
  read/unread (the WeldMail read mutations), so the mail count drops at once
  instead of within a minute.
- Optional: invalidate on realtime `mail`/`chat` notifications arriving through
  `UnifiedNotificationContext` (`subscribeToCategory`). Skip it if the 60s poll
  feels good enough.

### 6. Tests and checks

- Unit test for `AppRailBadge`: hidden at 0, `7`, `42`, `99+`.
- Unit test for the hook mapping: `weldmail`/`welddesk`/`weldchat` get counts,
  `weldconnect`/`weldcommerce` get none.
- The endpoint is unchanged, so `sidebar-badges.test.ts` stays as is.
- `pnpm --filter platform type-check` (12 GB heap), lint, and look at the rail
  in light and dark mode, collapsed and scrolled, with 0 / 5 / 150 unread.

## As built

- `components/layout/app-rail-badge.tsx`: `AppRailBadge`, `railBadgeSizeClass`,
  `formatRailBadgeCount`, and `RailIconCorner`. The unread badge and the BETA
  pill share the top-right corner, so the badge wins while there is a count
  and BETA comes back at 0.
- `hooks/use-sidebar-badges.ts`: `useAppRailBadges()` returns the per-app
  lookup (`railBadgeCountFor` is the pure mapping, unit tested);
  `refreshSidebarBadges(queryClient)` is called by `useMarkMailRead`,
  `useMarkThreadAsRead`, `useBulkMailAction` and the message view's
  "mark as read/unread" menu.
- Realtime invalidation (step 5, optional) was not done; the 60s poll stays.

## Out of scope

- Badges for WeldCommerce, WeldConnect, WeldFlow, WeldApps.
- Changing what the WeldDesk count means (it stays "all open tickets").
- Browser tab title / favicon counts.
