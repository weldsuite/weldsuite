---
name: weldsuite-email
description: "Design, add or change a WeldSuite system email (calendar invites, booking confirmations, notifications, invites, portal codes, digests) in packages/core/emails. Use when asked to create a new email, restyle the email layout, change email copy or translations, preview emails, or send an email from a worker or Next.js app."
---

# WeldSuite system emails

Every email WeldSuite sends on its own behalf lives in **`packages/core/emails`**
(`@weldsuite/emails`): React Email templates on **one shared layout**, en + nl copy,
sent through **Cloudflare Email Service** from `notifications@mail.weldsuite.org`.
Not in scope: WeldMail, helpdesk replies and workflow `send_email` actions. Those
send user-written mail from a workspace's own address.

Migration plan and status: `docs/plans/system-email-cloudflare.md`.

## Map

| File | What it is |
|---|---|
| `src/theme.ts` | **All** colors, fonts, sizes, radii, spacing, logo. Restyle every email here. |
| `src/components/layout.tsx` | `<EmailLayout>`: one narrow column on white, logo on top, footer under a hairline. Every template renders inside it. |
| `src/components/primitives.tsx` | `Kicker`, `Heading`, `Paragraph`, `Strong`, `Button`, `Actions`, `LinkFallback`, `TextLink`, `Quote`, `Details`, `Code`, `Divider`, `MultilineText`. |
| `src/brand.ts` | `EmailBrand`: `{ kind: 'weldsuite', module }` for members, `{ kind: 'workspace', name, logoUrl, accentColor }` for external people. |
| `src/templates/<area>/<name>.tsx` | One template each, built with `defineTemplate`. |
| `src/templates/index.ts` | Registry: template id → template. |
| `packages/core/i18n/src/locales/{en,nl}/emails.ts` | All copy. `nl` is typed against `en`, so a missing key fails type-check. |
| `src/format.ts` | Locale- and timezone-aware dates (`formatWhen`, `formatDate`, `formatTimeRange`). |
| `src/ics.ts` | `buildIcs` / `icsAttachment` for calendar attachments. |
| `src/send.ts` | `sendSystemEmail(transport, { template, props, to, locale, brand, replyTo, attachments })`. |
| `src/transports/` | `binding` (`workerTransport(env)` for Workers), `env` (`transportFromEnv(process.env)` for Next.js / scripts, uses `rest`), `memory` (tests), `resend` (migration fallback only). |
| Template ids | `calendar.event`, `meet.invitation`, `booking`, `workspace.invitation`, `notification`, `task.assigned`, `flow.digest`, `portal.sign-in`, `hr.portal-invite`, `admin.workspace-deletion`, `internal.enterprise-inquiry`. Reuse one before adding a near-duplicate. |
| Migration switches | `EMAIL_TRANSPORT=resend` (worker var / env) keeps a sender on Resend; `SYSTEM_EMAIL_FROM` overrides the sender address. Both go away in Phase 5 of the plan. |

## Design direction: modern and minimal

The look is that of Linear, Vercel or Stripe mail, not a marketing template. Keep it that way:

- White page and one narrow column (520px), left-aligned. No grey background, and no card, shadow or coloured bar.
- Hierarchy comes from type, not boxes. Write a muted `Kicker` line saying who did what, then the subject itself as the `Heading` (the event title, the booking page name).
- Use neutral greys, with ink (near black) for headings and the primary button. A workspace accent colour only colours buttons.
- Separate things with hairlines (`Details`, footer) and whitespace. No coloured borders, coloured panels or icons. Use `Quote` (thin grey rule) only for text someone else wrote.
- Use one primary button. A second action is a grey `secondary` button or an inline `TextLink` in a sentence.
- Copy is short and plain. Write no slogans, no "We're excited" and no exclamation marks. Say what happened and what to do.

## Design rules (email clients are not browsers)

- Compose primitives. Don't write raw `<div>`s, and don't use flexbox, grid,
  `position`, CSS variables or `<style>` blocks. Gmail and Outlook drop them.
  If a primitive is missing, add one to `primitives.tsx` built from React Email
  `Section`/`Row`/`Column`/`Text` with inline styles.
- **No hooks and no React context** (`useState`, `useContext`, `createContext`, …)
  anywhere in the package. Templates are also imported from Next.js Server
  Actions, whose React build has none of them, and the build fails. Pass values
  down as props instead.
- Every color, size and spacing value comes from `theme`. Colors are hex. A
  workspace accent color reaches the email only through
  `<Button accent={accentOf(brand)}>`. `accentOf()` validates it.
  `<LinkFallback>` takes its text as
  `label={emailStrings(locale).layout.linkFallback}`.
- Images: absolute `https://` URLs, with explicit width/height and alt text.
  SVG doesn't render in Gmail or Outlook; use 2x PNGs (WeldSuite assets go in
  `apps/web/platform/public/email/`).
- The column is 520px (`theme.width`). Check how it looks at a phone width too.
- Every button that links somewhere also gets a `<LinkFallback>` (the bare URL)
  when the link is the main point of the email (join links, magic links).
- User content (titles, names, descriptions) is passed as a React child, never
  as HTML, so it is escaped. Use `<MultilineText>` to keep its line breaks.
- The plain-text part is generated from the HTML (`htmlToText`). `<Details>` rows
  become `Label: value`. Keep that output readable; the snapshot test shows it.

## Copy rules

- Every user-visible string goes in `emails.ts` for **both** `en` and `nl`,
  under the template's area (`emails.calendar.*`, `emails.booking.*`, …).
  Shared strings go under `emails.layout`.
- Use `{name}` placeholders. Fill them with `fill()` for plain text, or with
  `rich()` when a value needs markup (a bold name inside a sentence). Never
  build sentences by concatenating translated fragments.
- Dutch uses informal "je". Product names (WeldCalendar, WeldMeet, …) are not
  translated.
- Format dates with `src/format.ts` in the recipient's locale and the event's
  timezone, never with `toLocaleString('en-US')`.

## Add a template

1. Create `src/templates/<area>/<name>.tsx`:
   ```tsx
   export interface FooEmailProps { … }
   export default defineTemplate<FooEmailProps>({
     defaultBrand: { kind: 'weldsuite', module: 'WeldFoo' },
     subject: (props, { locale }) => fill(emailStrings(locale).foo.subject, { … }),
     Component: (props) => (
       <EmailLayout brand={props.brand} locale={props.locale} preview={…}>
         <Heading>…</Heading>
         …
       </EmailLayout>
     ),
     previews: { default: { props: { … } }, /* one per variant */ },
   });
   ```
2. Register it in `src/templates/index.ts` and export its props type there.
3. Add its strings to `en/emails.ts` and `nl/emails.ts`.
4. Add `previews` that cover every variant: optional fields set and unset, and
   a workspace brand if external people receive it.
5. Run `pnpm --filter @weldsuite/emails test`. Each preview is rendered in every
   locale, and the run fails on unfilled placeholders, a missing nl key or a
   broken document. Review the new text snapshots, then commit them.

## Preview and iterate

- `pnpm --filter @weldsuite/emails dev` opens the React Email preview at
  http://localhost:3030 with every template × preview × locale (files under
  `emails/` are generated and git-ignored).
- Run it with `pnpm --filter …` from the repo root. `pnpm dev` inside the
  package folder starts the root `turbo dev` instead.
- To check a design yourself: render with `renderTemplate(...)` (tsx script),
  open the HTML in Playwright and screenshot it. Look at the result before you
  call a design done.
- The WeldSuite logo URL (`theme.logo.url`) only resolves once the platform is
  deployed. When screenshotting locally, serve it from
  `apps/web/platform/public/email/weldsuite-logo.png` with a Playwright route.

## Send

```ts
import { sendSystemEmail, icsAttachment, resolveEmailLocale } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';

const transport = workerTransport(c.env); // undefined → no SEND_EMAIL binding: skip
if (transport) {
  try {
    await sendSystemEmail(transport, {
      template: 'calendar.event',
      props: { kind: 'invite', organizerName, title, … },
      to: attendee.email,
      locale: resolveEmailLocale(recipientLanguage, workspaceLanguage),
      attachments: [icsAttachment({ uid: `${event.id}@weldsuite.org`, product: 'WeldCalendar', … })],
    });
  } catch (err) {
    console.error('[calendar] invite email failed', err); // mail never fails the mutation
  }
}
```

- The worker needs `[[send_email]] name = "SEND_EMAIL"` in every env block of
  its `wrangler.toml`, and `nodejs_compat`. Until Phase 0 of the plan is done,
  it also needs `EMAIL_TRANSPORT = "resend"` in its vars.
- Every package or app that depends on `@weldsuite/emails` needs
  `"jsx": "react-jsx"` in its `tsconfig.json`. The package ships `.tsx`
  sources, so the consumer's `tsc` compiles them.
- External recipients get a workspace brand (`{ kind: 'workspace', name, logoUrl, accentColor }`
  from `workspace_settings`), and `replyTo` set to the person they would answer.
- Next.js apps use `transportFromEnv(process.env)` from
  `@weldsuite/emails/transports/env`. List `@weldsuite/emails` and
  `@weldsuite/email` in `transpilePackages`. A static import works in Server
  Actions and route handlers; this was verified with a running Next 16 build.
- Tests use `memoryTransport()` and assert on `transport.sent`.
