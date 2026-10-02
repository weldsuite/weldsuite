/**
 * The recorder can take a while to start, so the header and the Meeting tools
 * panel show how long it has been starting. The strings come from the host app
 * (translated) with English defaults.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { MeetingHeader } from '../src/components/meeting-header';
import { MeetingToolsPanel } from '../src/components/meeting-tools-panel';

const headerProps = {
  meetingTitle: 'Standup',
  duration: 0,
  rightPanel: null,
  showChat: false,
  onToggleRightPanel: () => {},
  onToggleChat: () => {},
} as const;

test.describe('MeetingHeader · recording start elapsed time', () => {
  test('STARTING shows how long the recorder has been starting', async ({ mount }) => {
    const comp = await mount(
      <MeetingHeader
        {...headerProps}
        isRecording={false}
        recordingState="STARTING"
        recordingStartElapsedSeconds={12}
      />,
    );
    await expect(comp.getByText('12s')).toBeVisible();
  });

  test('labels override the English copy', async ({ mount }) => {
    const comp = await mount(
      <MeetingHeader
        {...headerProps}
        isRecording={false}
        recordingState="STARTING"
        recordingLabels={{ starting: 'Starten…' }}
      />,
    );
    await expect(comp.getByText('Starten…')).toBeVisible();
  });

  test('no elapsed counter once recording', async ({ mount }) => {
    const comp = await mount(
      <MeetingHeader
        {...headerProps}
        isRecording={true}
        recordingState="RECORDING"
        recordingStartElapsedSeconds={12}
      />,
    );
    await expect(comp.getByText('12s')).toHaveCount(0);
  });
});

test.describe('MeetingToolsPanel · recording start elapsed time', () => {
  test('STARTING appends the elapsed seconds to "Please wait…"', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={false}
        recordingState="STARTING"
        recordingStartElapsedSeconds={7}
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    await expect(comp.getByText('Please wait… 7s')).toBeVisible();
  });

  test('labels override the English copy', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={false}
        recordingState="STARTING"
        recordingStartElapsedSeconds={3}
        recordingLabels={{ startingTool: 'Opname starten…', pleaseWait: 'Even geduld…' }}
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    await expect(comp.getByRole('button', { name: /opname starten/i })).toBeVisible();
    await expect(comp.getByText('Even geduld… 3s')).toBeVisible();
  });
});
