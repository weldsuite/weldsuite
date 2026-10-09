# weldmeet-ui, Playwright component tests

These mount the shared in-call UI components in isolation (with a fake `meeting`
/ participant object) and assert the **host-control gating**, without a live
Cloudflare RealtimeKit / WebRTC connection, which is unreachable in normal e2e.

Both the **platform app** and the **meeting portal** render these same shared
components, so covering them once here covers the host controls for both apps.

| Spec | Covers |
| --- | --- |
| `participant-context-menu.ct.spec.tsx` | The 3-dots menu host actions (Mute for everyone / Turn off video / Remove from call) are shown only when `canManageParticipants` is true; hidden for guests and when the prop is omitted (fail-safe); self shows "Leave call"; local "Mute for me" is NOT host-gated |
| `meeting-tools-panel.ct.spec.tsx` | Recording control: IDLE → STARTING (spinner, non-interactive) / STOPPING / RECORDING; `recordingAvailable` host gating; start/stop fire only when not busy |
| `meeting-tools.ct.spec.tsx` | The meeting tools, with a host and a guest side by side in a fake room (`harness/tools-harness.tsx`): timer, Q&A, polls, breakout rooms, transcript + captions, on-device translation, live streaming; a late joiner catching up; host-only actions staying with the host |
| `meeting-header.ct.spec.tsx` | Header "Starting…" cue while recording is provisioning |
| `call-controls-bar-more-menu.ct.spec.tsx` | "More options" menu closes before Host controls / Background effects / Start recording run; starting a recording does not toast success on click |
| `preview-view.ct.spec.tsx` | Pre-join screen: English defaults, translated labels, mic/camera device pickers, empty device list, blocked-permission empty state |
| `recording-start-elapsed.ct.spec.tsx` | Header + Meeting tools show elapsed seconds (and translated labels) while the recorder is STARTING |
| `participant-name-tag.ct.spec.tsx` | Host-muted mic and the viewer's "muted for me" marker show together |
| `mobile.ct.spec.tsx` | Phone viewport: "More options" is a bottom sheet that also offers meeting details / tools and switches the layout; the header keeps only People and Chat; no share button when the browser cannot capture a screen; the share card hides once someone else joined. Desktop keeps the menu, every header button and the card |
| `call-controls-bar-leave.ct.spec.tsx` | Leave button: single action by default; with `onEndForAll` (host) it becomes a Leave meeting / End meeting for all menu, each item calling only its own handler |

## Running

```bash
# from packages/weldmeet-ui
pnpm test:ct          # headless
pnpm test:ct:ui       # Playwright UI
```

> Pin note: `@playwright/experimental-ct-react` is pinned to `1.57.0` to match
> the repo's `playwright`. Floating it to 1.60.x reintroduces a babel-transform
> crash in CT-core's bundled transform.
