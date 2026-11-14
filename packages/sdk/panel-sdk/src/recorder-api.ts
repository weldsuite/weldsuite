/**
 * The contract between the core and the recording plugin. The core loads the
 * plugin from `<collector>/rec.js` (dist/panel-recorder.global.js), which puts
 * its factory on `window[RECORDER_GLOBAL]`; apps that bundle the SDK can pass
 * the factory from `@weldsuite/panel-sdk/recorder` to `init()` instead.
 */

import type { ClientConfig, DeviceClass } from './wire';

export const RECORDER_GLOBAL = '__weldpanel_recorder';

export interface RecorderOptions {
  /** The collector's origin. */
  host: string;
  /** The project token. */
  token: string;
  maskingLevel: ClientConfig['maskingLevel'];
  debug?: boolean;
}

export interface PanelRecorder {
  /**
   * Record `sessionId`: starts rrweb (a full snapshot) unless it already runs
   * for this session; a different session first sends what the old one has.
   */
  start(sessionId: string): void;
  /** Send what is buffered and stop (consent withdrawn, an excluded page). */
  stop(): void;
  /** One masked full snapshot to `POST /snap`, for a heatmap background. */
  snapshot(pageGroupId: string, deviceClass: DeviceClass): Promise<void>;
}

export type RecorderFactory = (options: RecorderOptions) => PanelRecorder;
