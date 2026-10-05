/**
 * Component tests for the speaker picker of the call controls bar.
 *
 * The microphone's device menu also lists the audio outputs, so a participant
 * can send the call's sound to a headset without changing the system default.
 * The choice is kept for the next call.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { CallControlsBar } from '../src/components/call-controls-bar';

const noop = () => {};

function bar() {
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
    />
  );
}

/** Replaces the browser's device list with the given audio outputs. */
async function stubSpeakers(page: Page, speakers: Array<{ deviceId: string; label: string }>) {
  await page.evaluate((list) => {
    navigator.mediaDevices.enumerateDevices = () =>
      Promise.resolve(list.map((d) => ({ ...d, kind: 'audiooutput', groupId: 'g' }) as MediaDeviceInfo));
  }, speakers);
}

test.describe('CallControlsBar · speaker output', () => {
  test('lists the speakers and remembers the chosen one', async ({ mount, page }) => {
    await stubSpeakers(page, [
      { deviceId: 'default', label: 'Default - Speakers' },
      { deviceId: 'headset-1', label: 'Headset' },
    ]);
    await mount(bar());

    await page.getByRole('button', { name: 'Microphone options' }).click();
    await expect(page.getByText('Speaker', { exact: true })).toBeVisible();
    // Nothing chosen yet: the system default is the active output.
    await expect(page.getByRole('menuitemradio', { name: 'Default - Speakers' })).toBeChecked();

    await page.getByRole('menuitemradio', { name: 'Headset' }).click();
    expect(await page.evaluate(() => localStorage.getItem('weldmeet-speaker-output'))).toBe('headset-1');

    await page.getByRole('button', { name: 'Microphone options' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Headset' })).toBeChecked();
  });

  test('no speakers exposed: the menu is not offered', async ({ mount, page }) => {
    await stubSpeakers(page, []);
    await mount(bar());
    await expect(page.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Microphone options' })).toHaveCount(0);
  });
});
