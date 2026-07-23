/**
 * Component tests for the Meeting Tools panel's RECORDING control (host-only).
 *
 * Covers the recording-start feedback we added: the row reflects IDLE →
 * STARTING (spinner, "Please wait…", non-interactive) → RECORDING, and the
 * host-only gating (`recordingAvailable`). RTK provisions recording async, so
 * this deterministic UI is exactly what component tests are for.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { MeetingToolsPanel } from '../src/components/meeting-tools-panel';

test.describe('MeetingToolsPanel · recording', () => {
  test('idle + recordingAvailable: shows an enabled "Record" action', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={false}
        recordingState="IDLE"
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    const record = comp.getByRole('button', { name: /record/i });
    await expect(record).toBeVisible();
    await expect(record).toBeEnabled();
    await expect(comp.getByText('Capture the meeting')).toBeVisible();
  });

  test('STARTING: shows "Starting recording…" and is non-interactive', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={false}
        recordingState="STARTING"
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    const row = comp.getByRole('button', { name: /starting recording/i });
    await expect(row).toBeVisible();
    await expect(row).toBeDisabled();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(comp.getByText('Please wait…')).toBeVisible();
  });

  test('STOPPING: shows "Stopping recording…" and is non-interactive', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={true}
        recordingState="STOPPING"
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    const row = comp.getByRole('button', { name: /stopping recording/i });
    await expect(row).toBeVisible();
    await expect(row).toBeDisabled();
  });

  test('RECORDING: shows "Stop recording" (enabled)', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={true}
        recordingState="RECORDING"
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    const stop = comp.getByRole('button', { name: /stop recording/i });
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    await expect(comp.getByText('Recording in progress')).toBeVisible();
  });

  test('non-host (recordingAvailable=false): the Record row is disabled / "Coming soon"', async ({ mount }) => {
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={false}
        isRecording={false}
        recordingState="IDLE"
        startRecording={() => {}}
        stopRecording={() => {}}
      />,
    );

    const record = comp.getByRole('button', { name: /record/i });
    await expect(record).toBeVisible();
    await expect(record).toBeDisabled();
    // Premium/unavailable group renders a "Coming soon" badge.
    await expect(comp.getByText('Coming soon').first()).toBeVisible();
  });

  test('clicking "Record" calls startRecording', async ({ mount }) => {
    let started = 0;
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={false}
        recordingState="IDLE"
        startRecording={() => {
          started += 1;
        }}
        stopRecording={() => {}}
      />,
    );

    await comp.getByRole('button', { name: /record/i }).click();
    expect(started).toBe(1);
  });

  test('clicking "Stop recording" calls stopRecording', async ({ mount }) => {
    let stopped = 0;
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={true}
        recordingState="RECORDING"
        startRecording={() => {}}
        stopRecording={() => {
          stopped += 1;
        }}
      />,
    );

    await comp.getByRole('button', { name: /stop recording/i }).click();
    expect(stopped).toBe(1);
  });

  test('a busy row does NOT fire start/stop on click', async ({ mount }) => {
    let calls = 0;
    const comp = await mount(
      <MeetingToolsPanel
        recordingAvailable={true}
        isRecording={false}
        recordingState="STARTING"
        startRecording={() => {
          calls += 1;
        }}
        stopRecording={() => {
          calls += 1;
        }}
      />,
    );

    // The row is disabled; force the click to prove the handler is a no-op
    // while busy (handleRecord early-returns on recordingBusy).
    await comp.getByRole('button', { name: /starting recording/i }).click({ force: true });
    expect(calls).toBe(0);
  });
});
