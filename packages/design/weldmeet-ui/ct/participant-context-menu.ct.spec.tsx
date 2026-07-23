/**
 * Component tests for the participant 3-dots menu's HOST CONTROLS.
 *
 * This shared menu is rendered by both the platform app and the meeting portal.
 * The host-only actions — "Mute for everyone", "Turn off video", "Remove from
 * call" — are gated on `canManageParticipants` (default false). Guests in the
 * meeting portal pass `isOrganizer={false}` / `selfIsHost={false}`, which flows
 * down to `canManageParticipants={false}`, so they must NOT see these.
 *
 * The live in-call UI needs Cloudflare RealtimeKit + WebRTC (unreachable in
 * e2e), so we mount the menu directly with a fake participant/meeting instead.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { ParticipantContextMenu } from '../src/components/participant-context-menu';

const POSITION = { x: 20, y: 20 };

/** A fake RTK participant. Action methods resolve so the menu's awaits don't reject. */
function makeParticipant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p_alice',
    name: 'Alice Example',
    audioEnabled: true,
    videoEnabled: true,
    picture: undefined,
    disableAudio: () => Promise.resolve(),
    disableVideo: () => Promise.resolve(),
    kick: () => Promise.resolve(),
    pin: () => Promise.resolve(),
    unpin: () => Promise.resolve(),
    ...overrides,
  };
}

const HOST_ACTIONS = ['Mute for everyone', 'Turn off video', 'Remove from call'] as const;

test.describe('ParticipantContextMenu · host controls', () => {
  test('host (canManageParticipants=true) sees all three host actions', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {}}
        canManageParticipants={true}
      />,
    );

    for (const label of HOST_ACTIONS) {
      await expect(comp.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('guest (canManageParticipants=false) sees NONE of the host actions', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {}}
        canManageParticipants={false}
      />,
    );

    for (const label of HOST_ACTIONS) {
      await expect(comp.getByText(label, { exact: true })).toHaveCount(0);
    }
    // Not self either → no "Leave call" in the destructive section.
    await expect(comp.getByText('Leave call', { exact: true })).toHaveCount(0);
  });

  test('host actions default OFF when the prop is omitted (fail-safe)', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {}}
      />,
    );

    for (const label of HOST_ACTIONS) {
      await expect(comp.getByText(label, { exact: true })).toHaveCount(0);
    }
  });

  test('own menu shows "Leave call" and never the host actions', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={true}
        meeting={{ leave: () => {} }}
        position={POSITION}
        onClose={() => {}}
        // Even if somehow true, self never targets itself with host actions.
        canManageParticipants={true}
      />,
    );

    await expect(comp.getByText('Leave call', { exact: true })).toBeVisible();
    await expect(comp.getByText('Mute for everyone', { exact: true })).toHaveCount(0);
    await expect(comp.getByText('Remove from call', { exact: true })).toHaveCount(0);
  });

  test('clicking "Mute for everyone" closes the menu (action wired)', async ({ mount }) => {
    let closed = false;
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {
          closed = true;
        }}
        canManageParticipants={true}
      />,
    );

    await comp.getByText('Mute for everyone', { exact: true }).click();
    expect(closed).toBe(true);
  });

  test('"Mute for everyone" is disabled when the participant is already muted', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant({ audioEnabled: false })}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {}}
        canManageParticipants={true}
      />,
    );

    await expect(
      comp.getByRole('button', { name: /mute for everyone/i }),
    ).toBeDisabled();
  });
});

test.describe('ParticipantContextMenu · local playback ("Mute for me")', () => {
  test('a guest still gets the local "Mute for me" control (not host-gated)', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {}}
        canManageParticipants={false}
        volume={100}
        localMuted={false}
        onVolumeChange={() => {}}
        onLocalMutedChange={() => {}}
      />,
    );

    await expect(comp.getByText('Mute for me', { exact: true })).toBeVisible();
    // ...and still NOT the host action.
    await expect(comp.getByText('Mute for everyone', { exact: true })).toHaveCount(0);
  });

  test('local playback row is hidden when its handlers are not wired', async ({ mount }) => {
    const comp = await mount(
      <ParticipantContextMenu
        participant={makeParticipant()}
        isSelf={false}
        meeting={{}}
        position={POSITION}
        onClose={() => {}}
        canManageParticipants={false}
      />,
    );

    await expect(comp.getByText('Mute for me', { exact: true })).toHaveCount(0);
  });
});
