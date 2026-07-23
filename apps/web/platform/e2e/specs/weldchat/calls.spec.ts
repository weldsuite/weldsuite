/**
 * WeldChat voice/video call coverage.
 *
 * The live call experience is built on Cloudflare RealtimeKit (real WebRTC +
 * media devices) and its signalling backend still lives on the obsolete
 * `api-worker` under `/chat/calls/*`. Neither is reachable in the E2E env
 * (app-api only, no media devices, no RealtimeKit cloud), so an *actual*
 * connected call can't be driven here. What IS deterministic — and what these
 * tests cover — is everything around it:
 *
 *   1. The standalone Call Room page (`/call-room`). It's a top-level route
 *      opened by the mobile app's webview; it reads its auth token from the URL
 *      and needs no Clerk session or backend. With no token it lands straight in
 *      the error state — pure client state, zero network, fully deterministic.
 *
 *   2. The call entry points in the channel header (the Video / Voice buttons).
 *      These render against a real seeded channel served by app-api, including
 *      the per-channel "calls disabled" branch. We assert they render / hide and
 *      are enabled — we never click them, since a click would kick off the
 *      RealtimeKit + api-worker flow that isn't available in test.
 *
 * The in-call surfaces that are purely context-driven (IncomingCallToast,
 * SwitchCallDialog, ActiveCallBanner, the connected room controls) can't be
 * reached without that live backend, so they're intentionally out of scope here
 * — their stable `data-testid`s are in place for a future RealtimeKit-mocked
 * pass.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

// ---------------------------------------------------------------------------
// Standalone Call Room page — client-state only, no seeding required
// ---------------------------------------------------------------------------

test.describe('WeldChat · call room (/call-room)', () => {
  test('shows the "unable to join" error when no token is supplied', async ({ page }) => {
    // No `token` search param → CallRoomPage flips to status='error' on mount
    // without making any network request.
    await page.goto('/call-room');

    const error = page.getByTestId('call-room-error');
    await expect(error).toBeVisible({ timeout: 15_000 });

    await expect(error.getByText(/unable to join call/i)).toBeVisible();
    await expect(error.getByText(/call link may have expired/i)).toBeVisible();
  });

  test('error state is independent of the call type param', async ({ page }) => {
    // The missing-token guard runs before the call-type branch, so a video call
    // link with no token lands in exactly the same error state.
    await page.goto('/call-room?type=video');

    await expect(page.getByTestId('call-room-error')).toBeVisible({ timeout: 15_000 });
    // The connecting spinner must NOT be shown — there's no token to connect with.
    await expect(page.getByTestId('call-room-connecting')).toBeHidden();
  });

  test('the error state offers an enabled Close action', async ({ page }) => {
    await page.goto('/call-room');
    await expect(page.getByTestId('call-room-error')).toBeVisible({ timeout: 15_000 });

    // Present + enabled. We deliberately don't click it: it calls window.close(),
    // which would tear down the page and is a no-op for a non-script-opened tab.
    const close = page.getByTestId('call-room-close');
    await expect(close).toBeVisible();
    await expect(close).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Channel header call entry points — seed a real channel via app-api
// ---------------------------------------------------------------------------

// Each test loads a full channel page (REST queries + websocket room + active-
// call polling), the heaviest WeldChat surface. Serial keeps at most one live
// at a time so local parallelism doesn't starve sibling specs. (CI pins
// workers:1 already.) Mirrors messaging.spec.ts.
test.describe('WeldChat · channel call controls (seed-gated)', () => {
  test.describe.configure({ mode: 'serial' });

  let channelId: string | null = null;

  test.beforeAll(() => {
    test.skip(
      !isTestFixturesConfigured(),
      'test-fixtures env vars not set — skipping seeded WeldChat call-control tests',
    );
  });

  test.afterEach(async ({ api }) => {
    if (channelId) {
      await api.deleteEntity('chatChannel', channelId);
      channelId = null;
    }
  });

  test('a channel shows enabled video + voice call buttons', async ({ page, api }) => {
    const channel = await api.seedChatChannel({ name: `E2E Calls ${Date.now().toString(36)}` });
    channelId = channel.id;

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // The header (with the call buttons) renders once the channel loads.
    await expect(page.getByTestId('chat-channel-name')).toBeVisible({ timeout: 15_000 });

    const videoBtn = page.getByTestId('chat-call-video');
    const voiceBtn = page.getByTestId('chat-call-voice');

    await expect(videoBtn).toBeVisible();
    await expect(voiceBtn).toBeVisible();

    // No active call (the /chat/calls/active poll 404s in test → hasActiveCall
    // is false), so both controls are enabled and ready to start a call.
    await expect(videoBtn).toBeEnabled();
    await expect(voiceBtn).toBeEnabled();

    // Their tooltips name the action — not the "call already active" fallback.
    await expect(videoBtn).toHaveAttribute('title', /video call/i);
    await expect(voiceBtn).toHaveAttribute('title', /voice call/i);
  });

  test('a channel with calls disabled hides both call buttons', async ({ page, api }) => {
    const channel = await api.seedChatChannel({
      name: `E2E NoCalls ${Date.now().toString(36)}`,
      voiceCallsEnabled: false,
      videoCallsEnabled: false,
    });
    channelId = channel.id;

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Wait for the header to render before asserting the buttons are absent —
    // otherwise the count could be 0 simply because the page hasn't loaded yet.
    await expect(page.getByTestId('chat-channel-name')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('chat-call-video')).toHaveCount(0);
    await expect(page.getByTestId('chat-call-voice')).toHaveCount(0);
  });
});
