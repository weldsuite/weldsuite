/**
 * Turning the local microphone back on in a RealtimeKit meeting.
 *
 * RTK's `self.enableAudio()` only flips `enabled` on the track it already
 * holds. When that track has ended (the user revoked microphone access in the
 * browser, the device went away) the flip does nothing and the mic stays off
 * for the rest of the call (TASK-713). `enableMicrophone` makes RTK acquire a
 * fresh track first, the same way the camera toggle does.
 */

/** The slice of RTK's `meeting.self` the microphone helpers need. */
export interface MicrophoneSelf {
  readonly audioEnabled: boolean;
  readonly rawAudioTrack?: MediaStreamTrack;
  enableAudio(): Promise<void>;
  getAllDevices(): Promise<MediaDeviceInfo[]>;
  getCurrentDevices?(): { audio?: MediaDeviceInfo };
  setDevice(device: MediaDeviceInfo): Promise<void>;
}

export interface EnableMicrophoneResult {
  /** The mic is on after the call. */
  enabled: boolean;
  /** The browser (or OS) refuses microphone access for this site. */
  blocked: boolean;
}

function readRawAudioTrack(self: MicrophoneSelf): MediaStreamTrack | undefined {
  try {
    return self.rawAudioTrack;
  } catch {
    return undefined;
  }
}

function readCurrentMicId(self: MicrophoneSelf): string | undefined {
  try {
    return self.getCurrentDevices?.()?.audio?.deviceId;
  } catch {
    return undefined;
  }
}

async function findMicrophone(self: MicrophoneSelf): Promise<MediaDeviceInfo | undefined> {
  let all: MediaDeviceInfo[] = [];
  try {
    all = (await self.getAllDevices()) ?? [];
  } catch {
    return undefined;
  }
  const mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId);
  const currentId = readCurrentMicId(self);
  return (
    mics.find((d) => d.deviceId === currentId) ??
    mics.find((d) => d.deviceId === 'default') ??
    mics[0]
  );
}

/** Whether the browser reports microphone access as denied for this site. */
export async function isMicrophonePermissionDenied(): Promise<boolean> {
  const query = typeof navigator === 'undefined'
    ? undefined
    : navigator.permissions?.query?.bind(navigator.permissions);
  if (!query) return false;
  try {
    const status = await query({ name: 'microphone' as PermissionName });
    return status.state === 'denied';
  } catch {
    return false;
  }
}

/**
 * Turns the local mic on, re-acquiring it when the track RTK holds has ended.
 * Never throws; the result says whether the mic is on and, if not, whether
 * the browser blocks it.
 */
export async function enableMicrophone(self: MicrophoneSelf): Promise<EnableMicrophoneResult> {
  if (readRawAudioTrack(self)?.readyState === 'ended') {
    // setDevice() drops the dead track and asks the browser for a new one.
    const mic = await findMicrophone(self);
    if (mic) {
      try {
        await self.setDevice(mic);
      } catch (err) {
        console.warn('[WeldMeet] re-acquiring the microphone failed:', err);
      }
    }
  }
  try {
    await self.enableAudio();
  } catch (err) {
    console.error('[WeldMeet] enableAudio failed:', err);
  }
  // RTK resolves without a track when the browser blocks the mic, so read the
  // real state instead of assuming the unmute worked.
  const enabled = !!self.audioEnabled;
  return { enabled, blocked: !enabled && (await isMicrophonePermissionDenied()) };
}
