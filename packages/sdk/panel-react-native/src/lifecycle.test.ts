import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDevice, memoryStorage, setup, TOKEN } from './test/harness';

const STATE = `weldpanel:${TOKEN}`;
const NO_CONSENT_NEEDED = { config: { consentMode: 'none' } };

afterEach(() => {
  vi.useRealTimers();
});

function storedRecord(appVersion?: string | null): string {
  const record: Record<string, unknown> = {
    anonId: 'a_stored',
    sessionId: 's_stored',
    lastEventAt: Date.now(),
    granted: true,
    superProps: {},
    groups: {},
  };
  if (appVersion !== undefined) record.appVersion = appVersion;
  return JSON.stringify(record);
}

describe('app lifecycle', () => {
  it('$app_opened on start and on each return to the foreground; $app_backgrounded sends at once', async () => {
    vi.useFakeTimers();
    const device = fakeDevice();
    const { panel, idle, net } = setup({ device, network: NO_CONSENT_NEEDED, flushIntervalMs: 60_000 });
    await panel.ready;
    expect(device.listeners()).toBe(1);

    // iOS passes through `inactive` (control centre, the app switcher): not a background.
    device.setAppState('inactive');
    device.setAppState('active');
    expect(net.attempts).toHaveLength(0);

    device.setAppState('background');
    await idle();
    expect(net.names()).toEqual(['$app_installed', '$app_opened', '$app_backgrounded']);

    device.setAppState('active');
    device.setAppState('active');
    panel.track('Back');
    await panel.flush();
    await idle();
    expect(net.names()).toEqual(['$app_installed', '$app_opened', '$app_backgrounded', '$app_opened', 'Back']);
    panel.shutdown();
  });

  it('a launch in the background sends $app_opened only when the app comes to the foreground', async () => {
    const device = fakeDevice({ appState: 'background' });
    const { panel, idle, net } = setup({ device });
    await panel.ready;
    panel.track('Background fetch');
    device.setAppState('active');
    await panel.flush();
    await idle();
    expect(net.names()).toEqual(['Background fetch', '$app_opened']);
  });

  it('$app_installed only on the first launch with consent', async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    await first.panel.flush();
    await first.idle();
    expect(first.net.names()).toEqual(['$app_opened']);
    expect(storage.writes).toEqual([]);

    first.panel.consent.grant();
    first.panel.consent.grant();
    await first.panel.flush();
    await first.idle();
    expect(first.net.names()).toEqual(['$app_opened', '$app_installed']);
    expect(storage.json(STATE)).toMatchObject({ appVersion: '2.1.0' });
    first.panel.shutdown();

    const second = setup({ storage });
    await second.panel.flush();
    await second.idle();
    expect(second.net.names()).toEqual(['$app_opened']);
  });

  it('$app_updated with the previous version when the stored version differs', async () => {
    const storage = memoryStorage({ [STATE]: storedRecord('2.0.0') });
    const { panel, idle, net } = setup({ storage });
    await panel.flush();
    await idle();
    expect(net.names()).toEqual(['$app_updated', '$app_opened']);
    const updated = net.events()[0];
    expect(updated.props).toMatchObject({ previous_version: '2.0.0', $app_version: '2.1.0' });
    expect(updated.anon_id).toBe('a_stored');
    expect(storage.json(STATE)).toMatchObject({ appVersion: '2.1.0' });
  });

  it('neither when the version is the same, or unknown', async () => {
    for (const [stored, app] of [
      ['2.1.0', { id: 'com.acme.shop', version: '2.1.0' }],
      [null, { id: 'com.acme.shop' }],
      ['2.0.0', { id: 'com.acme.shop' }],
    ] as const) {
      const storage = memoryStorage({ [STATE]: storedRecord(stored) });
      const { panel, idle, net } = setup({ storage, app });
      await panel.flush();
      await idle();
      expect(net.names()).toEqual(['$app_opened']);
    }
  });

  it('captureLifecycle: false sends no lifecycle events, but still sends on background', async () => {
    const device = fakeDevice();
    const { panel, idle, net, storage } = setup({ device, captureLifecycle: false, network: NO_CONSENT_NEEDED });
    await panel.ready;
    panel.track('Only this');
    device.setAppState('background');
    await idle();
    expect(net.names()).toEqual(['Only this']);
    // The launch is still recorded, so turning lifecycle events on later doesn't report everyone as new.
    expect(storage?.json(STATE)).toMatchObject({ appVersion: '2.1.0' });
  });
});
