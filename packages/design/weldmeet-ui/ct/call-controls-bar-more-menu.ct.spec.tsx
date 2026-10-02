/**
 * Component tests for the CallControlsBar "More options" menu.
 *
 * Items that open a side panel (Host controls, Background effects) or a dialog
 * (Start recording) must close the menu first, then run their action; the menu
 * used to stay open over the panel it had just opened (TASK-732).
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

test.describe('CallControlsBar · More options menu', () => {
  test('"Host controls" closes the menu and then opens the panel', async ({ mount, page }) => {
    let opened = 0;
    await mount(bar({ onOpenSettings: () => { opened += 1; } }));

    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Host controls' }).click();

    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => opened).toBe(1);
  });

  test('"Background effects" closes the menu and toggles the panel', async ({ mount, page }) => {
    let toggled = 0;
    await mount(bar({ onToggleEffects: () => { toggled += 1; } }));

    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Background effects' }).click();

    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => toggled).toBe(1);
  });

  test('starting a recording does not claim success on click', async ({ mount, page }) => {
    let starts = 0;
    await mount(bar({ startRecording: () => { starts += 1; }, isRecording: false, recordingState: 'IDLE' }));

    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Start recording' }).click();

    await expect.poll(() => starts).toBe(1);
    // The "started" toast now comes from the host app once RTK reports RECORDING.
    await expect(page.getByText('Recording started')).toHaveCount(0);
  });
});
