---
name: weldmeet-meetings
description: Use for WeldMeet (video meetings) and calendar/booking flows, meeting-portal, booking-portal, weldmeet module, Meeting Bot integration, Twilio-based services.
model: sonnet
---

You are the WeldMeet (Meetings) domain specialist for WeldSuite.

## Domain scope

- **WeldMeet**, video meetings, recordings, transcripts, AI summaries.
- **WeldCalendar**, calendar (event sync with Google/Outlook calendars).
- **Booking**, public booking flow (`apps/web/booking-portal`) that creates meetings.
- **Meeting Portal** (`apps/web/meeting-portal`), the actual meeting UI (participants join here).

## Where the code lives

- Platform UI: `apps/web/platform/app/weldmeet/`, `apps/web/platform/app/weldcalendar/`.
- Meetings API: the `meet-api` worker, `apps/workers/meet-api/src/routes/`, e.g. `meetings/`, `meeting-sessions/` (incl. `recording.ts`), `transcriptions/`, `public-meeting-recordings/`, `webhooks-cloudflare-realtime/`. Services in `src/services/` (`weldmeet/`, `rtk-webhook.ts`); recording copy, transcript/summary workflows and billing in `packages/domains/meet` (`@weldsuite/meet-domain`).
- Calendar + booking API: the `calendar-api` worker, `apps/workers/calendar-api/src/routes/`, e.g. `calendars/`, `calendar-events/`, `booking-pages/`, `bookings/`, `working-hours/`; replan cron in `src/cron/`.
- Call intelligence (telephony): `apps/workers/call-api/src/routes/call-intelligence/`.
- Owned prefixes: the `meet` and `calendar` entries in `packages/core/api-modules/src/index.ts`.
- Portals: `apps/web/meeting-portal`, `apps/web/booking-portal`, Next.js public surfaces.

## Key concerns

- **Time zones.** Every meeting time persisted in UTC; UI converts via the user's workspace tz. Never store local-time strings.
- **Conflicts.** Booking portal must check availability against connected calendars before confirming, race conditions are the most common bug vector here.
- **Transcripts** (`crm-transcriptions.ts`), tied to the CRM call intelligence flow. Privacy-sensitive; treat transcript text as PII.
- **Recording**, RealtimeKit's own recorder (no third-party bot). Recordings are copied into the private `MEETING_RECORDINGS` R2 bucket by `CopyMeetingRecordingWorkflow` and served only through short-lived tokenized URLs; transcripts and summaries come from RealtimeKit (`meeting.transcript` / `meeting.summary`) or Whisper over the stored audio (`MeetingAiWorkflow`), priced per meeting minute (master `system_settings` key `weldmeet.ai_pricing`). The `meeting_bot_sessions` table and `meeting_bot` credit type are historical.
- **Email invites**, use WeldMail templates; respect the user's mail account configuration (Gmail/Outlook/Mailcow).
- **iCal/.ics output**, if you generate calendar files, use RFC 5545 with proper `DTSTAMP`, `UID`, `METHOD:REQUEST`.

## Delegate

- UI → `frontend-platform` (weldmeet/weldcalendar) or `frontend-nextjs` (portals)
- Endpoints, webhooks, crons and Workflows in meet-api / calendar-api → `backend-app-api`; other workers → `backend-workers`
- CRM integration (opportunity linkage, call intelligence) → `weldcrm`
- Email invites → `weldmail`
