/**
 * Component tests for the pre-join (PreviewView) screen.
 *
 * Covers the host/guest preview upgrades: device pickers, translated labels with
 * English defaults, and a sane empty state when the browser blocks both camera
 * and microphone. Device lists are plain MediaDeviceInfo-shaped fakes.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { PreviewView } from '../src/components/preview-view';

const noop = () => {};

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: 'g', toJSON: () => ({}) } as MediaDeviceInfo;
}

const baseProps = {
  meetingTitle: 'Weekly sync',
  previewStream: null,
  previewAudioEnabled: true,
  previewVideoEnabled: false,
  togglePreviewAudio: noop,
  togglePreviewVideo: noop,
  confirmJoinFromPreview: noop,
  cancelPreview: noop,
} as const;

test.describe('PreviewView', () => {
  test('keeps the English defaults when no labels are passed', async ({ mount }) => {
    const comp = await mount(<PreviewView {...baseProps} />);

    await expect(comp.getByText('Weekly sync')).toBeVisible();
    await expect(comp.getByText('Check your audio and video before joining')).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Join Meeting' })).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Cancel' })).toBeVisible();
    // No picker props -> plain toggles, no device menus.
    await expect(comp.getByRole('button', { name: 'Microphone', exact: true })).toHaveCount(0);
  });

  test('uses the translated labels it is given', async ({ mount }) => {
    const comp = await mount(
      <PreviewView
        {...baseProps}
        labels={{ subtitle: 'Controleer je geluid en beeld', join: 'Deelnemen', cancel: 'Annuleren' }}
      />,
    );

    await expect(comp.getByText('Controleer je geluid en beeld')).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Deelnemen' })).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Annuleren' })).toBeVisible();
  });

  test('lists the microphones and switches device on pick', async ({ mount, page }) => {
    const picked: string[] = [];
    await mount(
      <PreviewView
        {...baseProps}
        audioInputs={[device('audioinput', 'mic-1', 'Built-in mic'), device('audioinput', 'mic-2', 'USB headset')]}
        videoInputs={[]}
        selectedAudioInputId="mic-1"
        selectedVideoInputId=""
        onChangeAudioInput={(id) => picked.push(id)}
        onChangeVideoInput={noop}
      />,
    );

    await page.getByRole('button', { name: 'Microphone', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'USB headset' }).click();

    expect(picked).toEqual(['mic-2']);
  });

  test('an empty camera list says so', async ({ mount, page }) => {
    await mount(
      <PreviewView
        {...baseProps}
        audioInputs={[]}
        videoInputs={[]}
        onChangeAudioInput={noop}
        onChangeVideoInput={noop}
        audioPermission="granted"
        videoPermission="granted"
      />,
    );

    await page.getByRole('button', { name: 'Camera', exact: true }).click();
    await expect(page.getByText('No cameras detected')).toBeVisible();
  });

  test('both devices blocked: explains it instead of showing a blank preview', async ({ mount }) => {
    const comp = await mount(<PreviewView {...baseProps} audioPermission="denied" videoPermission="denied" />);

    await expect(comp.getByRole('alert')).toContainText('Camera and microphone are blocked');
    // The blocked buttons still lead to the how-to-allow help.
    await expect(comp.getByRole('button', { name: /microphone access blocked/i })).toBeVisible();
    await expect(comp.getByRole('button', { name: /camera access blocked/i })).toBeVisible();
    // Joining without media stays possible.
    await expect(comp.getByRole('button', { name: 'Join Meeting' })).toBeEnabled();
  });
});
