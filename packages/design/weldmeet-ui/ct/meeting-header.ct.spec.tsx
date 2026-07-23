/**
 * Component tests for the meeting header's recording indicator.
 *
 * The header shows a "Starting…" cue while recording is being provisioned
 * (recordingState === 'STARTING') and a steady red dot once it's RECORDING —
 * so the host gets feedback even with the Tools panel closed.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { MeetingHeader } from '../src/components/meeting-header';

const baseProps = {
  meetingTitle: 'Standup',
  duration: 0,
  rightPanel: null,
  showChat: false,
  onToggleRightPanel: () => {},
  onToggleChat: () => {},
} as const;

test.describe('MeetingHeader · recording indicator', () => {
  test('STARTING shows a "Starting…" cue', async ({ mount }) => {
    const comp = await mount(
      <MeetingHeader {...baseProps} isRecording={false} recordingState="STARTING" />,
    );
    await expect(comp.getByText(/starting/i)).toBeVisible();
  });

  test('RECORDING hides the "Starting…" cue (steady indicator instead)', async ({ mount }) => {
    const comp = await mount(
      <MeetingHeader {...baseProps} isRecording={true} recordingState="RECORDING" />,
    );
    await expect(comp.getByText(/starting/i)).toHaveCount(0);
  });

  test('IDLE shows no recording cue at all', async ({ mount }) => {
    const comp = await mount(
      <MeetingHeader {...baseProps} isRecording={false} recordingState="IDLE" />,
    );
    await expect(comp.getByText(/starting/i)).toHaveCount(0);
  });
});
