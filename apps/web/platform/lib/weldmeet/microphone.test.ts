import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableMicrophone, type MicrophoneSelf } from '@weldsuite/weldmeet-ui/lib/microphone';

function device(deviceId: string, kind: MediaDeviceKind = 'audioinput'): MediaDeviceInfo {
  return { deviceId, kind, label: deviceId, groupId: 'g', toJSON: () => ({}) } as MediaDeviceInfo;
}

function track(readyState: MediaStreamTrackState): MediaStreamTrack {
  return { readyState } as MediaStreamTrack;
}

/** A fake RTK `meeting.self` that turns on when enableAudio() runs, unless `stuck`. */
function fakeSelf(options: {
  track?: MediaStreamTrack;
  devices?: MediaDeviceInfo[];
  currentMicId?: string;
  stuck?: boolean;
}) {
  const calls: string[] = [];
  const self = {
    audioEnabled: false as boolean,
    rawAudioTrack: options.track,
    enableAudio: vi.fn(async () => {
      calls.push('enableAudio');
      if (!options.stuck) self.audioEnabled = true;
    }),
    getAllDevices: vi.fn(async () => options.devices ?? []),
    getCurrentDevices: () => ({ audio: options.currentMicId ? device(options.currentMicId) : undefined }),
    setDevice: vi.fn(async (d: MediaDeviceInfo) => {
      calls.push(`setDevice:${d.deviceId}`);
    }),
  } satisfies MicrophoneSelf & { audioEnabled: boolean };
  return { self, calls };
}

function stubMicPermission(state: PermissionState | null) {
  const query = state === null ? undefined : vi.fn(async () => ({ state }));
  vi.stubGlobal('navigator', { ...navigator, permissions: query ? { query } : undefined });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enableMicrophone (TASK-713)', () => {
  it('just unmutes a live mic track', async () => {
    const { self, calls } = fakeSelf({ track: track('live'), devices: [device('mic-1')] });
    await expect(enableMicrophone(self)).resolves.toEqual({ enabled: true, blocked: false });
    expect(calls).toEqual(['enableAudio']);
  });

  it('re-acquires the current mic before unmuting when its track has ended', async () => {
    const { self, calls } = fakeSelf({
      track: track('ended'),
      devices: [device('default'), device('mic-1'), device('cam-1', 'videoinput')],
      currentMicId: 'mic-1',
    });
    await expect(enableMicrophone(self)).resolves.toEqual({ enabled: true, blocked: false });
    expect(calls).toEqual(['setDevice:mic-1', 'enableAudio']);
  });

  it('falls back to the default mic when the current one is unknown', async () => {
    const { self, calls } = fakeSelf({
      track: track('ended'),
      devices: [device('mic-2'), device('default')],
    });
    await enableMicrophone(self);
    expect(calls).toEqual(['setDevice:default', 'enableAudio']);
  });

  it('lets RTK acquire a new track itself when it holds none', async () => {
    const { self, calls } = fakeSelf({ track: undefined, devices: [device('mic-1')] });
    await expect(enableMicrophone(self)).resolves.toEqual({ enabled: true, blocked: false });
    expect(calls).toEqual(['enableAudio']);
  });

  it('reports a browser block when the mic stays off', async () => {
    stubMicPermission('denied');
    const { self } = fakeSelf({ track: track('ended'), devices: [device('mic-1')], stuck: true });
    await expect(enableMicrophone(self)).resolves.toEqual({ enabled: false, blocked: true });
  });

  it('does not report a block when access is allowed but the mic still fails', async () => {
    stubMicPermission('granted');
    const { self } = fakeSelf({ track: track('live'), stuck: true });
    await expect(enableMicrophone(self)).resolves.toEqual({ enabled: false, blocked: false });
  });

  it('never throws when RTK does', async () => {
    stubMicPermission(null);
    const { self } = fakeSelf({ track: track('ended'), devices: [device('mic-1')], stuck: true });
    self.setDevice.mockRejectedValueOnce(new Error('NotAllowedError'));
    self.enableAudio.mockRejectedValueOnce(new Error('Failed to unmute track'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(enableMicrophone(self)).resolves.toEqual({ enabled: false, blocked: false });
  });
});
