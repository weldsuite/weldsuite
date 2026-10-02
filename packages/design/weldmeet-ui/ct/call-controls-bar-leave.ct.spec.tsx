/**
 * Component tests for the CallControlsBar leave button.
 *
 * Non-hosts (and every other consumer: meeting-portal, WeldChat) get a single
 * red leave button. When a host passes `onEndForAll`, the same button becomes a
 * menu with "Leave meeting" (just leaves) and a destructive "End meeting for
 * all". The menu has no extra confirm dialog.
 *
 * The bar only touches `meeting` through device enumeration, which tolerates
 * `null`, so we mount it without a live RealtimeKit client.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { CallControlsBar } from '../src/components/call-controls-bar';

const noop = () => {};

function bar(extra: Partial<React.ComponentProps<typeof CallControlsBar>> = {}) {
  return (
    <CallControlsBar
      meeting={null}
      isMuted={false}
      isVideoOff={false}
      isScreenSharing={false}
      handRaised={false}
      viewMode="grid"
      toggleMute={noop}
      toggleVideo={noop}
      startScreenShare={() => Promise.resolve()}
      stopScreenShare={noop}
      toggleHandRaise={noop}
      setViewMode={noop}
      onLeave={noop}
      {...extra}
    />
  );
}

test.describe('CallControlsBar · leave button', () => {
  test('without onEndForAll the leave button is a single action that calls onLeave', async ({ mount, page }) => {
    let leaves = 0;
    await mount(bar({ onLeave: () => { leaves += 1; } }));

    await page.getByRole('button', { name: 'Leave call' }).click();

    expect(leaves).toBe(1);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
  });

  test('with onEndForAll the button opens a menu with both items and calls nothing yet', async ({ mount, page }) => {
    let leaves = 0;
    let ends = 0;
    await mount(bar({ onLeave: () => { leaves += 1; }, onEndForAll: () => { ends += 1; } }));

    await page.getByRole('button', { name: 'Leave call' }).click();

    await expect(page.getByRole('menuitem', { name: 'Leave meeting' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'End meeting for all' })).toBeVisible();
    expect(leaves).toBe(0);
    expect(ends).toBe(0);
  });

  test('"Leave meeting" calls onLeave only', async ({ mount, page }) => {
    let leaves = 0;
    let ends = 0;
    await mount(bar({ onLeave: () => { leaves += 1; }, onEndForAll: () => { ends += 1; } }));

    await page.getByRole('button', { name: 'Leave call' }).click();
    await page.getByRole('menuitem', { name: 'Leave meeting' }).click();

    expect(leaves).toBe(1);
    expect(ends).toBe(0);
  });

  test('"End meeting for all" calls onEndForAll only', async ({ mount, page }) => {
    let leaves = 0;
    let ends = 0;
    await mount(bar({ onLeave: () => { leaves += 1; }, onEndForAll: () => { ends += 1; } }));

    await page.getByRole('button', { name: 'Leave call' }).click();
    await page.getByRole('menuitem', { name: 'End meeting for all' }).click();

    expect(ends).toBe(1);
    expect(leaves).toBe(0);
  });

  test('leaveLabels override the menu labels', async ({ mount, page }) => {
    await mount(
      bar({
        onEndForAll: noop,
        leaveLabels: { leaveMeeting: 'Vergadering verlaten', endForAll: 'Vergadering voor iedereen beëindigen' },
      }),
    );

    await page.getByRole('button', { name: 'Leave call' }).click();

    await expect(page.getByRole('menuitem', { name: 'Vergadering verlaten' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Vergadering voor iedereen beëindigen' })).toBeVisible();
  });
});
