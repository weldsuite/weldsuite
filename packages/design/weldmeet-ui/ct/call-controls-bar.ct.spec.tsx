/**
 * Component tests for the mic / camera buttons of the call controls bar.
 *
 * When the browser blocks microphone or camera access the button must not
 * look "on": it renders in the red off state with a warning badge, and
 * clicking it opens help on granting access instead of toggling (TASK-721).
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { CallControlsBar } from '../src/components/call-controls-bar';
import { DEFAULT_PERMISSION_HELP_LABELS } from '../src/components/permission-help';

const baseProps = {
  meeting: null,
  isMuted: false,
  isVideoOff: false,
  isScreenSharing: false,
  handRaised: false,
  viewMode: 'grid',
  toggleMute: () => {},
  toggleVideo: () => {},
  startScreenShare: async () => {},
  stopScreenShare: () => {},
  toggleHandRaise: () => {},
  setViewMode: () => {},
  onLeave: () => {},
} as const;

test.describe('CallControlsBar · mic / camera state', () => {
  test('devices on: offers to turn them off', async ({ mount }) => {
    const comp = await mount(<CallControlsBar {...baseProps} />);
    await expect(comp.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
  });

  test('devices off: offers to turn them on', async ({ mount }) => {
    const comp = await mount(<CallControlsBar {...baseProps} isMuted isVideoOff />);
    await expect(comp.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
  });

  test('mic blocked: shows the blocked label and help on click', async ({ mount, page }) => {
    const comp = await mount(<CallControlsBar {...baseProps} micBlocked />);
    await expect(comp.getByRole('button', { name: /turn (on|off) microphone/i })).toHaveCount(0);
    await comp.getByRole('button', { name: DEFAULT_PERMISSION_HELP_LABELS.microphoneBlockedAction }).click();
    await expect(page.getByText(DEFAULT_PERMISSION_HELP_LABELS.microphoneTitle, { exact: true })).toBeVisible();
    // Camera isn't blocked, so it keeps its normal toggle.
    await expect(comp.getByRole('button', { name: 'Turn off camera' })).toBeVisible();
  });

  test('camera blocked: uses the translated labels passed in', async ({ mount, page }) => {
    const labels = {
      ...DEFAULT_PERMISSION_HELP_LABELS,
      cameraBlockedAction: 'Cameratoegang geblokkeerd — klik voor hulp',
      cameraTitle: 'Cameratoegang geblokkeerd',
    };
    const comp = await mount(<CallControlsBar {...baseProps} cameraBlocked permissionHelpLabels={labels} />);
    await comp.getByRole('button', { name: labels.cameraBlockedAction }).click();
    await expect(page.getByText(labels.cameraTitle, { exact: true })).toBeVisible();
  });
});
