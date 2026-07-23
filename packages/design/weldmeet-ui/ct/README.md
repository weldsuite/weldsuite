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
| `meeting-header.ct.spec.tsx` | Header "Starting…" cue while recording is provisioning |

## Running

```bash
# from packages/weldmeet-ui
pnpm test:ct          # headless
pnpm test:ct:ui       # Playwright UI
```

> Pin note: `@playwright/experimental-ct-react` is pinned to `1.57.0` to match
> the repo's `playwright`. Floating it to 1.60.x reintroduces a babel-transform
> crash in CT-core's bundled transform.
