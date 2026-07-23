# Meeting portal, Playwright e2e

End-to-end tests for the guest join flow (`/[orgId]/[joinCode]`).

## Approach

The portal's own `/api/meeting/*` routes need a tenant DB + Cloudflare
RealtimeKit, neither available in CI. Every spec therefore **mocks** those
routes with `page.route(...)` via `helpers/mock-meeting-api.ts`, so the whole
server-driven guest journey is deterministic with no backend:

| Spec | Covers |
| --- | --- |
| `specs/meeting-info.spec.ts` | loading state; cancelled / completed / failed-load error screens |
| `specs/landing.spec.ts` | meeting title + organizer + sign-in link; editable name/email; Join button validity gating |
| `specs/join-flow.spec.ts` | `waiting`, `host_must_join_first`, waiting-room `waitlisted` → admitted / denied, `ended`, `joined` → connecting |

The pre-join camera preview calls `getUserMedia`, so the config grants
camera/mic permissions and launches Chromium with fake media devices.

## Out of scope (by design)

The **connected in-call room** runs on live RealtimeKit / WebRTC, which Playwright
can't drive. Its host-control gating (mute-for-everyone, remove, recording, the
participant 3-dots menu) is covered by the **component tests** in
`packages/design/weldmeet-ui/ct/`, the portal and the platform render those same
shared components, so testing them once at the component level covers both apps.

## Running

```bash
# from apps/web/meeting-portal, starts `next dev` on :3020 automatically
pnpm test:e2e            # headless
pnpm test:e2e:ui         # Playwright UI
pnpm test:e2e:headed     # visible browser
pnpm test:e2e:report     # open last HTML report
```

No `.env` is required, all network calls are mocked. Set `BASE_URL` to point at
an already-running server instead of the bundled `webServer`.
