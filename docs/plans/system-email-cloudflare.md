# System email: Resend → Cloudflare Email Service, one layout in code

Status: Phases 1–4 done; mail.weldsuite.org onboarded in Cloudflare Email Service. Test environment: every worker on Cloudflare (calendar-api verified with Gmail/Outlook 2026-10-05); booking-portal/admin need CF_ACCOUNT_ID + CF_EMAIL_SEND_TOKEN in Vercel. Next: soak in test, then production, then Phase 5 (remove Resend).

## Goal

Every system email WeldSuite sends (calendar, meet, booking, invites,
notifications, digest, portals, admin) goes out through **Cloudflare Email
Service** and is rendered from **React Email templates in this repo**, all on one
shared layout. Resend, its dashboard templates and every inline HTML shell are
removed. Designing or changing an email becomes "edit a `.tsx` file, look at the
preview, commit", which Claude can do end to end.

## Decisions

| Topic | Decision |
|---|---|
| Scope | All system email. Calendar, Meet and booking go first. |
| Templates | React Email (`@react-email/components` + `render`), with the `email dev` preview server |
| Branding | One modern, minimal layout. Internal mail shows the WeldSuite logo, and the module (WeldCalendar, WeldMeet, …) is the sender name. Mail to external people (booking guests, portal users, meeting guests) shows the workspace logo and accent color, with a small "Sent via WeldSuite" footer. |
| Language | en + nl from the start. Strings go in `@weldsuite/i18n` under a new `emails` namespace. |

**Out of scope.** These send user-authored content from a workspace's own
address, not system mail:
- WeldMail sends
- helpdesk agent replies
- CRM, workflow and helpdesk-workflow `send_email` actions
- the `test-email-worker`
- the parcel `email_templates` table

## Current state (what gets replaced)

Two transports: Resend (raw `fetch`, in `@weldsuite/transactional-email` plus three
inline copies) and the Workers `send_email` binding (`@weldsuite/worker-email`).
Six separate inline HTML shells, no shared layout, English only.

| # | Email | Where | Transport today | HTML today |
|---|---|---|---|---|
| 1 | Calendar invite / update / reschedule / cancel / removed (+ .ics) | `apps/workers/calendar-api/src/services/calendar-mail.ts` | inline Resend `postToResend` | `wrapLayout` + 4 renderers, optional Resend dashboard templates |
| 2 | WeldMeet invitation (+ .ics) | `apps/workers/meet-api/src/services/weldmeet/invitations.ts` | transactional-email | inline string |
| 3 | Booking confirmed / rescheduled / cancelled / guest invite (+ .ics) | `apps/web/booking-portal/lib/booking-emails.ts` (Next.js server actions) | transactional-email | 4× inline dark card |
| 4 | Workspace invitation | `apps/workers/workspace-worker/src/routes/webhooks/clerk.ts` | `sendTemplateEmail` | **Resend dashboard template** |
| 5 | Notification mirror (chat DM/mention/thread/missed call, agent, desk live, task assigned) | `packages/core/notifications/src/channels/email.ts` (+ deferred workflow in app-api) | transactional-email | plain text only; task-assigned is a Resend dashboard template |
| 6 | Daily task digest | `packages/domains/flow/src/workflows/send-digest.ts` | inline Resend, binding fallback | `buildDigestHtml` |
| 7 | Enterprise inquiry (internal, to sales) | `apps/workers/app-api/src/services/internal-email.ts` + `services/billing.ts` | inline Resend, binding fallback | inline table |
| 8 | HR portal invite / sign-in code | `apps/workers/hr-api/src/services/weldhr/portal-mail.ts` | binding | white-label `layout()` |
| 9 | Commerce portal magic link / OTP | `apps/workers/commerce-api/src/services/commerce-portal-mail.ts` | binding | 4 `<p>` tags |
| 10 | Workspace deletion scheduled / cancelled | `apps/web/admin/lib/workspace-deletion-email.ts` (Next.js) | transactional-email | `shell()` |

There is also a known bug. calendar-api's `icsAttachment` passes raw ICS text
where Resend expects base64. It goes away when the ICS code is unified (Phase 1).

## Target architecture

### New package `@weldsuite/emails` (`packages/core/emails`)

```
packages/core/emails/
  src/
    theme.ts               ← every color, font, size, radius, spacing. The one file to restyle all mail.
    brand.ts               ← EmailBrand = { kind: 'weldsuite', module } | { kind: 'workspace', name, logoUrl?, accentColor? }
    i18n.ts  format.ts     ← locale resolution, fill()/rich() placeholders, Intl date formatting
    components/
      layout.tsx           ← <EmailLayout brand locale preview footer>: logo, one narrow column on white, hairline footer
      primitives.tsx       ← Kicker, Heading, Paragraph, Button, Actions, LinkFallback, Quote, Details, Code, Divider, …
    define.ts              ← defineTemplate({ defaultBrand, subject, Component, previews })
    templates/
      calendar/event.tsx   ← kind: invite | update | reschedule | cancel | removed
      booking/booking.tsx  ← kind: confirmed | rescheduled | cancelled | guest
      meet/invitation.tsx  workspace/invitation.tsx  notifications/notification.tsx
      task/assigned.tsx  flow/digest.tsx  portal/sign-in.tsx  hr/portal-invite.tsx
      admin/workspace-deletion.tsx  internal/enterprise-inquiry.tsx
      index.ts             ← typed registry: id → template
    render.ts              ← renderEmail(id, props, { locale, brand }) → { subject, html, text }
    send.ts                ← sendSystemEmail(transport, { template, props, to, locale, brand, replyTo?, attachments?, headers? })
    transports/
      binding.ts           ← Workers `send_email` binding (reuses @weldsuite/email CloudflareSendProvider) + workerTransport(env)
      rest.ts              ← Cloudflare REST POST /accounts/{id}/email/sending/send via the official SDK, for Next.js apps
      env.ts               ← transportFromEnv(process.env): REST when CF creds are set, else Resend
      resend.ts            ← migration fallback only, deleted in Phase 5
      memory.ts            ← test transport that records sends
    ics.ts                 ← single ICS builder (merges calendar-api's generateIcs and transactional-email's buildIcsInvite)
    preview.tsx            ← glue for the preview server
  scripts/generate-previews.ts ← writes emails/<id>/<preview>.<locale>.tsx (git-ignored) for `email dev`
```

Each template is a component that takes typed props plus `locale` and
`brand`. It exports a `subject` function next to it, and named `previews` that
feed both the preview server and the tests. The plain-text part is generated
from the HTML (`html-to-text`), so nobody maintains a second text template.
That fixes the notifications that are text-only today.

Rendering uses `react-dom/server.edge` directly instead of
`@react-email/render`. The edge build of `@react-email/render` statically
imports prettier (about 1 MB), which every sending worker would otherwise ship.

**Email-client rules baked into the components.** Templates only compose
components, so they cannot break these rules:
- table layout, one 520px column
- inline styles only, no flex or grid
- absolute image URLs
- a hidden preheader
- dark-mode-safe colors
- the button is a bulletproof `<a>`

Don't use React Email's `<Tailwind>`. It does CSS processing at render time and
bloats the worker. Styles come from `theme.ts`.

### i18n

New `emails.ts` in `packages/core/i18n/src/locales/{en,nl}/` (es/fr fall back to
en), nested per template (`emails.calendar.invite.subject`, …) plus shared
layout strings (`emails.layout.footer`, `emails.layout.sentVia`).

Recipient locale is resolved by one helper in the package:
- **workspace members:** `user_preferences.language` → `workspace_settings.language` → `en`
- **external recipients** (guests, booking customers, portal users): workspace language → `en`

Dates and times are formatted with `Intl` in the recipient's locale and the
event's timezone. This replaces the hardcoded `en-US` / `en-GB`.

### Transport

- **Workers** use the `[[send_email]] name = "SEND_EMAIL"` binding, restricted
  with `allowed_sender_addresses` to the WeldSuite senders.
  - Add the binding to calendar-api, meet-api, workspace-worker, chat-api and agent-api.
  - Add it to any other worker that calls the notifications helpers (helpdesk-widget-api).
  - app-api, flow-api, hr-api and commerce-api already have it.
- **Next.js apps** (booking-portal, admin) use the REST API with a
  `CF_EMAIL_SEND_TOKEN` (an API token with only Email Sending: Send) plus
  `CF_ACCOUNT_ID`. It goes through `cloudflare/tree-shakable`; SDK 7.0.0
  already has `emailSending.send`.
- **From address (decided):** everything is sent from
  `notifications@mail.weldsuite.org` (`SYSTEM_FROM_ADDRESS`). Only the display
  name varies:
  - the module (WeldCalendar, WeldMeet, …) for member mail
  - the workspace, or `"<Host> via <Workspace>"`, for customer-facing mail, with
    Reply-To set to the host
  - the HR and commerce portals move off bare `noreply@weldsuite.org`, which also
    protects the root domain's reputation

### Designing with Claude

- `pnpm --filter @weldsuite/emails dev` starts the React Email preview at
  localhost:3030. It shows every template in en and nl, with internal and
  workspace branding.
- `pnpm --filter @weldsuite/emails test` renders every template preview in every
  locale and snapshots the subject and plain text. It also asserts there are no
  unfilled placeholders, no missing translation keys and no unescaped user input.
- The skill at `.claude/skills/weldsuite-email/SKILL.md` covers:
  - the layout and theme tokens
  - the component list
  - email-client constraints
  - how to add a template (component + subject + i18n keys en/nl + previews + registry entry)
  - the loop: edit → preview → screenshot → test
- An optional `pnpm --filter @weldsuite/emails send-test <id> <to>` sends a real
  render to an inbox through the REST API, to check Gmail and Outlook.

## Phases

### Phase 0: prerequisites and spike (blocking)

1. Onboard `mail.weldsuite.org` (test and production) in Cloudflare Email
   Service, with SPF, DKIM and DMARC aligned.
   - Keep the Resend DKIM records until Phase 5 so both providers can send in parallel.
2. Spike in test with the binding. Send to an external Gmail and an Outlook
   address, with HTML + text + a `.ics` attachment, and confirm it arrives as a
   calendar invite.
   - `packages/core/email/src/providers/cloudflare/send.ts` notes that the
     structured `send({...})` threw on this account. Re-test it.
   - If it still fails, the binding transport keeps the raw-MIME `EmailMessage`
     path, which is proven in production for the HR and commerce portal mails.
3. Spike the REST endpoint with a scoped token, from a Node script.
4. Check the Email Service sending limits and quotas against current Resend
   volume (digest plus notifications are the bulk).

### Phase 1: foundation (`@weldsuite/emails`), done

- Package scaffold, theme, brand, layout and components, render, i18n
  namespace, transports, unified ICS (with tests ported from
  `calendar-mail.test.ts`), the preview server, snapshot tests and the Claude
  skill.
- Three templates serve as design samples: `calendar.event` (member brand),
  `booking.confirmed` (workspace brand) and `notification`. None of them is
  wired to a sender yet.
- The WeldSuite logo is a 2x PNG at
  `apps/web/platform/public/email/weldsuite-logo.png`. It is served from
  `app.weldsuite.org/email/…` once the platform deploys.
- **Fixed on the way:** `@weldsuite/email`'s `buildRfc5322` passed Reply-To to
  mimetext as a string. mimetext only accepts its own `Mailbox` object, so every
  binding send that set a Reply-To threw. Booking and Meet depend on Reply-To.
- **Measured bundle cost** (esbuild, production, workerd conditions): the full
  send path is 545 KB minified / 157 KB gzipped. Of that, about 145 KB is
  mimetext + mime-db, which binding workers already ship. The new part is about
  370 KB (react-dom/server 193 KB, html-to-text + entities about 120 KB).
- **Design checkpoint:** the first card-based layout read as generic, so it was
  redone in a modern, minimal style. It now has a white page, a narrow column, the
  subject as the heading, hairlines instead of coloured panels, and dark buttons.
  The direction is recorded in the skill. Get sign-off in the preview before any
  template is migrated.

### Phases 2–4: every sender on the templates, done

Phases 2–4 shipped together. Every system email now renders from
`@weldsuite/emails`. **Senders still go through Resend until Phase 0 is done**:
see "Rollout switches" below.

| Template id | Sender |
|---|---|
| `calendar.event` | calendar-api `services/calendar-mail.ts` (Resend dashboard template ids dropped) |
| `meet.invitation` | meet-api `services/weldmeet/invitations.ts` |
| `booking` (confirmed / rescheduled / cancelled / guest) | booking-portal `lib/booking-emails.ts`, via `transportFromEnv` |
| `workspace.invitation` | workspace-worker Clerk webhook (replaces the Resend dashboard template) |
| `notification`, `task.assigned` | `@weldsuite/notifications` + app-api deferred-email workflow. Every notification now has an HTML body; the task-assigned dashboard template is gone. |
| `flow.digest` | `packages/domains/flow` send-digest workflow, still workspace-branded, with List-Unsubscribe |
| `hr.portal-invite`, `portal.sign-in` | hr-api `services/weldhr/portal-mail.ts` |
| `portal.sign-in` (link + code) | commerce-api `services/commerce-portal-mail.ts` |
| `admin.workspace-deletion` | admin `lib/workspace-deletion-email.ts`, via `transportFromEnv` |
| `internal.enterprise-inquiry` | app-api billing route |

**Rollout switches** (until Phase 0 is done and verified in test):
- Workers that sent through Resend have `EMAIL_TRANSPORT = "resend"` in every
  `[vars]` block. They keep sending through Resend, now with the new templates.
  To move a worker to Cloudflare, change the var to `"cloudflare"`. To fall back
  without a code change, set it back to `"resend"`.
- `workerTransport` also falls back to Resend when a worker has a
  `RESEND_API_KEY` but no `SEND_EMAIL` binding.
- hr-api and commerce-api only ever sent through the binding, from
  `noreply@weldsuite.org`. They have `SYSTEM_EMAIL_FROM = "noreply@weldsuite.org"`,
  which keeps that verified sender. Remove the var once `mail.weldsuite.org` is
  onboarded, so they send from `notifications@mail.weldsuite.org` like the rest.
- The Next.js apps (booking-portal, admin) use Cloudflare REST as soon as
  `CF_ACCOUNT_ID` and `CF_EMAIL_SEND_TOKEN` are set, and Resend otherwise.
  `EMAIL_TRANSPORT=resend` forces Resend.

**Pitfalls hit and fixed in this phase:**
- Most API workers alias `react` to an empty shim in `wrangler.toml` to keep
  React out of their bundle. A worker that bundles `@weldsuite/emails` must not:
  with the shim, every email fails at runtime while the tests (real React) pass.
  The alias was removed from calendar, meet, app, agent, chat, flow, hr and
  commerce, and `packages/core/emails/src/worker-config.test.ts` now fails CI if a
  worker that reaches the package aliases react again.
- Next.js Server Actions run on a React build without hooks or context, so the
  package uses neither (accent and strings are props). Rendering from a Server
  Action or route handler with a static import was verified on a running Next 16
  build (admin).
- Consumers need `"jsx": "react-jsx"` in their tsconfig (the package ships .tsx).

Left in place on purpose: app-api's generic `/api/internal/send-email` and
`/send-transactional-email` relays, which carry caller-supplied HTML.

### Phase 5: remove Resend (after Phase 0 is verified in production)

- Flip every `EMAIL_TRANSPORT` to `cloudflare`, drop `SYSTEM_EMAIL_FROM`, set
  `CF_ACCOUNT_ID` + `CF_EMAIL_SEND_TOKEN` for booking-portal and admin, and watch
  a week of production mail.
- Delete `transports/resend.ts`, the `EMAIL_TRANSPORT` switch and the
  Resend fallback in `workerTransport` / `transportFromEnv`.
- Delete `packages/core/transactional-email/src/resend.ts` and
  `sendTemplateEmail`. Move or delete the rest of the package (ICS is now in
  `@weldsuite/emails`).
- Remove the `EMAIL_TRANSPORT` var, the `RESEND_*` secrets from
  `scripts/secrets/manifest.ts`, Doppler and the workers, and the Resend
  comments in the wrangler.toml files.
- Remove Resend's DNS records and update CLAUDE.md (package list, email section).

## Risks

- **Structured `send()` unavailable** on the account. Mitigation: the raw-MIME
  path already works (Phase 0 decides).
- **Deliverability during the switch** (new sending IPs, DKIM change).
  Mitigation: DKIM for both providers during the overlap, the `EMAIL_TRANSPORT`
  fallback, and a test-env soak before production.
- **Worker bundle size** from React + react-dom/server: about 370 KB minified
  per sending worker (measured in Phase 1). This is acceptable on Workers Paid.
  Re-check with `wrangler deploy --dry-run` on the first migrated worker.
- **No bounce or complaint webhooks are wired today.** Cloudflare returns
  `permanent_bounces` per send; log them. Suppression handling is a follow-up,
  not part of this plan.

## Open questions

1. Where are `booking-portal` and `admin` hosted (they are not in
   `deploy.yml`)? That decides where `CF_EMAIL_SEND_TOKEN` lives. The
   alternative is to route their sends through an app-api internal endpoint so
   no Cloudflare token sits in a Next.js app.
