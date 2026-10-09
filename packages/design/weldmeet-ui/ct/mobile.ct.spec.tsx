/**
 * Component tests for the in-call UI on a phone-sized viewport.
 *
 * Below 768px the header keeps only People and Chat, and the control bar's
 * "More options" becomes a bottom sheet that also carries what no longer fits
 * elsewhere: meeting details, meeting tools and the device pickers. Browsers
 * that cannot capture a screen (phones) get no share button at all.
 *
 * These specs mount without Tailwind, so they assert what is rendered, not how
 * it is laid out.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { CallControlsBar } from '../src/components/call-controls-bar';
import { MeetingHeader } from '../src/components/meeting-header';
import { MeetingRoomView } from '../src/components/meeting-room-view';

const PHONE = { width: 390, height: 844 };
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

function header(extra: Partial<React.ComponentProps<typeof MeetingHeader>> = {}) {
  return (
    <MeetingHeader
      meetingTitle="Standup"
      duration={0}
      rightPanel={null}
      showChat={false}
      onToggleRightPanel={noop}
      onToggleChat={noop}
      {...extra}
    />
  );
}

function room(names: string[]) {
  return (
    <MeetingRoomView
      meetingId="mtg_1"
      meetingTitle="Standup"
      shareUrl="https://meet.example.test/org/abc"
      meeting={null}
      participants={names.map((name, i) => ({ id: `peer-${i}`, name, audioEnabled: false, videoEnabled: false }))}
      isMuted={false}
      isVideoOff
      isScreenSharing={false}
      handRaised={false}
      duration={0}
      isOrganizer={false}
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

test.describe('phone viewport', () => {
  test.use({ viewport: PHONE });

  test('"More options" opens a sheet that also offers details and tools', async ({ mount, page }) => {
    let tools = 0;
    await mount(bar({ onOpenInfo: noop, onOpenTools: () => { tools += 1; } }));

    await page.getByRole('button', { name: 'More options' }).click();
    const sheet = page.getByRole('dialog', { name: 'More options' });
    await expect(sheet.getByRole('button', { name: 'Meeting details' })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);

    await sheet.getByRole('button', { name: 'Meeting tools' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => tools).toBe(1);
  });

  test('the sheet switches the layout', async ({ mount, page }) => {
    const modes: string[] = [];
    await mount(bar({ setViewMode: (mode) => { modes.push(mode); } }));

    await page.getByRole('button', { name: 'More options' }).click();
    const sheet = page.getByRole('dialog', { name: 'More options' });
    await expect(sheet.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('button', { name: 'Speaker' }).click();

    await expect.poll(() => modes).toEqual(['speaker']);
  });

  test('the share button is there when the browser can capture a screen', async ({ mount }) => {
    const comp = await mount(bar());
    await expect(comp.getByRole('button', { name: 'Share screen' })).toBeVisible();
  });

  test('no share button where the browser cannot capture a screen', async ({ mount, page }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true });
    });
    const comp = await mount(bar());
    await expect(comp.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Raise hand' })).toBeVisible();
    await expect(comp.getByRole('button', { name: 'Share screen' })).toHaveCount(0);
  });

  test('the header keeps People and Chat when the rest moved to the sheet', async ({ mount }) => {
    const comp = await mount(header({ mobileOverflowActions: true, participantsCount: 2 }));
    await expect(comp.getByTitle('People')).toBeVisible();
    await expect(comp.getByTitle('Chat')).toBeVisible();
    await expect(comp.getByTitle('Meeting details')).toHaveCount(0);
    await expect(comp.getByTitle('Meeting tools')).toHaveCount(0);
  });

  test('the header keeps every button when nothing else offers them', async ({ mount }) => {
    const comp = await mount(header());
    await expect(comp.getByTitle('Meeting details')).toBeVisible();
    await expect(comp.getByTitle('Meeting tools')).toBeVisible();
  });

  test('the share card steps aside once someone else has joined', async ({ mount }) => {
    const alone = await mount(room(['Ada']));
    await expect(alone.getByText("Your meeting's ready")).toBeVisible();
    await alone.unmount();

    const together = await mount(room(['Ada', 'Grace']));
    await expect(together.getByText('Grace')).toBeVisible();
    await expect(together.getByText("Your meeting's ready")).toBeHidden();
  });
});

test.describe('desktop viewport', () => {
  test('"More options" stays a menu, and the header keeps its buttons', async ({ mount, page }) => {
    await mount(bar({ onOpenInfo: noop, onOpenTools: noop }));
    await page.getByRole('button', { name: 'More options' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Meeting details')).toHaveCount(0);
  });

  test('the header ignores the overflow flag', async ({ mount }) => {
    const comp = await mount(header({ mobileOverflowActions: true }));
    await expect(comp.getByTitle('Meeting details')).toBeVisible();
    await expect(comp.getByTitle('Meeting tools')).toBeVisible();
  });

  test('the share card stays while others are in the call', async ({ mount }) => {
    const comp = await mount(room(['Ada', 'Grace']));
    await expect(comp.getByText("Your meeting's ready")).toBeVisible();
  });
});
