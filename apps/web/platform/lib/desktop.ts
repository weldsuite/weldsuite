import type { DesktopSource, WeldsuiteDesktopApi } from '../types/weldsuite-desktop';

export function getDesktop(): WeldsuiteDesktopApi | null {
  if (typeof window === 'undefined') return null;
  return window.weldsuiteDesktop ?? null;
}

export function isDesktop(): boolean {
  return getDesktop() !== null;
}

async function pickDesktopSource(opts?: {
  types?: Array<'screen' | 'window'>;
}): Promise<DesktopSource[]> {
  const desktop = getDesktop();
  if (!desktop) return [];
  return desktop.getDesktopSources({
    types: opts?.types ?? ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
}

async function captureDesktopSource(sourceId: string, maxResolution = 1080): Promise<MediaStream> {
  const maxWidth = maxResolution >= 1440 ? 2560 : maxResolution >= 1080 ? 1920 : 1280;
  const maxHeight = maxResolution >= 1440 ? 1440 : maxResolution >= 1080 ? 1080 : 720;
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth,
        maxHeight,
        maxFrameRate: 30,
      },
    } as MediaTrackConstraints,
  });
}

async function showDesktopNotification(title: string, body?: string): Promise<boolean> {
  const desktop = getDesktop();
  if (!desktop) return false;
  return desktop.showNotification({ title, body });
}

async function setBadgeCount(count: number): Promise<void> {
  await getDesktop()?.setBadgeCount(count);
}
