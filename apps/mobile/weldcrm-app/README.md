# WeldCRM mobile app

Expo (React Native) app for WeldCRM. It follows the platform's WeldCRM
(`apps/web/platform/app/weldcrm`) and reads and writes the same data through the
first-party API, so a record changed on the phone is the same record on the web.

## Screens

| Tab / screen | What it does | Data |
| --- | --- | --- |
| Home | Your tasks due today or overdue, recent activity, and a + button to create a person, company, task, note, deal or activity | flow-api `/tasks`, `/activities` |
| Companies / People (tabs) | Search and an All / Leads / Suppliers filter; call, email, edit, archive, delete | `/companies`, `/people?inCrm=true` |
| Company / person (`/company/[id]`, `/person/[id]`) | Every Details field (owner, manager, status, lifecycle, language, tags, address, custom fields, …) and the record tabs: Activity, People / Companies, Deals, Notes, Tasks, Emails, Calls, Meetings, Files, Audit log, Chat | see `components/record-panels.tsx` |
| Deals (More, `/deals`) | Pipeline board with a pipeline switcher; long press moves a deal to another stage | `/pipelines`, `/pipeline-stages?pipeline=`, `/opportunities` |
| Deal (`/deal/[id]`, `/deal/new`) | All deal fields, stage, mark won / lost / reopen, delete, the deal's activity | `/opportunities/:id` |
| Tasks | My tasks or all CRM tasks, grouped by due date; status, priority, assignees, linked company or person, labels, repeat | flow-api `/tasks?crmLinked=true`, the same rows as the web's My Tasks |
| Notes (More, `/notes`, `/note/[id]`) | Notes with title and text, pinned first; linked to a company or person | `/activities?type=note` (HTML body, as the web editor writes it) |
| More | Deals, Notes, Lists, Sequences, workspace switcher, dark mode, language, sign out | `/lists`, `/sequences` |
| Log activity (`/activity/new`) | Call, email, meeting or note for a company, person or deal | `/activities` |

## Code layout

- `services/api.ts`: people, companies, links, members, custom fields, pipelines, deals, activities, dashboard.
- `services/tasks.ts`, `services/notes.ts`, `services/record-tabs.ts`, `services/lists.ts`, `services/sequences.ts`.
- `components/record-screen.tsx`: the shared company / person screen; `components/record-panels.tsx`: its tabs.
- `lib/`: pure helpers (dates, money, validation, note HTML, custom fields, field options) with tests in `__tests__/`.
- Strings: `lib/i18n/locales/en.ts` and `nl.ts` (`nl` is typed against `en`, so a missing key fails type-check).

Two server rules the data layer relies on: people / company / deal PATCH schemas drop
unknown keys silently, and `customFields` on PATCH replaces the stored map, so the app
always sends the whole merged map.

## Run

```bash
pnpm --filter weldcrm-app start          # dev client
node ../../../node_modules/jest/bin/jest.js   # unit tests (jest is hoisted to the repo root)
pnpm --filter weldcrm-app lint
maestro test .maestro                    # e2e, see .maestro/README.md
```

`.env` is gitignored; copy the `preview` profile env from `eas.json` (test API) plus the
Clerk publishable key.

## Images

`assets/images/` holds the WeldCRM icon, splash and sign-in mark, generated from the
platform's brand SVG; see `assets/images/README.md`.
