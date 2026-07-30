/**
 * Structural types for the live RealtimeKit meeting client.
 *
 * These components are presentational and version-tolerant: they call into the
 * RTK client defensively (`on?.()`, `toArray?.()`) because the host apps run
 * different SDK minors, and they only ever touch a small slice of its surface.
 * Importing `RealtimeKitClient` wholesale would couple every prop signature to
 * the SDK's exact shape, so instead we describe just the slice we use.
 *
 * ─── Why every function member uses method-shorthand syntax ──────────────────
 * `on(event: string, …)` written as a *property* with a function type is
 * checked contravariantly under `strictFunctionTypes`, so RTK's own
 * `<E extends keyof SelfEvents>(event: E, …)` would NOT be assignable to it and
 * host apps could not pass their real client in without a cast. Method
 * shorthand opts into bivariant parameter checking, which is exactly the
 * "close enough, I know what I'm doing" adapter semantics we want here.
 * Keep these as methods — switching one to a property breaks every call site.
 */

/** A media track container as exposed by RTK on participants. */
export interface ScreenShareTracks {
  video?: MediaStreamTrack | null;
  audio?: MediaStreamTrack | null;
}

/** A remote participant in the call. */
export interface MeetingParticipant {
  id: string;
  name?: string;
  picture?: string;
  /** Host-app identity, when the participant was joined via an authenticated seat. */
  userId?: string;
  /** Host-app supplied stable id — preferred over `userId`/`id` for avatar colors. */
  customParticipantId?: string;

  audioEnabled?: boolean;
  videoEnabled?: boolean;
  screenShareEnabled?: boolean;

  audioTrack?: MediaStreamTrack | null;
  videoTrack?: MediaStreamTrack | null;
  screenShareTracks?: ScreenShareTracks;

  /** Set by the host app for outbound-call tiles that are still ringing. */
  ringing?: boolean;
  ringingLabel?: string;

  /** True while this participant is pinned/spotlighted by the local viewer. */
  pinned?: boolean;

  pin?(): Promise<void>;
  unpin?(): Promise<void>;
  kick?(): Promise<void>;
  disableAudio?(): Promise<void>;
  disableVideo?(): Promise<void>;

  on?(event: string, handler: (...args: never[]) => void): unknown;
  off?(event: string, handler: (...args: never[]) => void): unknown;
}

/** A message sent over RTK's participant broadcast channel. */
export interface BroadcastMessage {
  type: string;
  payload: Record<string, unknown>;
}

/** A single transcription event from RTK's AI/transcription channel. */
export interface TranscriptEvent {
  id?: string;
  peerId?: string;
  name?: string;
  transcript?: string;
  /** `false` marks a finalized line; anything else is treated as still partial. */
  isPartialTranscript?: boolean;
}

/** RTK's AI/transcription channel. */
export interface MeetingAi {
  on?(event: 'transcript', handler: (t: TranscriptEvent) => void): unknown;
  off?(event: 'transcript', handler: (t: TranscriptEvent) => void): unknown;
}

/** Device selection as reported by `self.getCurrentDevices()`. */
export interface CurrentDevices {
  audio?: MediaDeviceInfo;
  video?: MediaDeviceInfo;
  speaker?: MediaDeviceInfo;
}

/**
 * RTK's video middleware is an opaque callable produced by the virtual-background
 * transformer — we only ever hand it straight back to `add/removeVideoMiddleware`.
 */
export type VideoMiddleware = (...args: never[]) => unknown;

/** The local participant. Adds self-only capabilities on top of a participant. */
export interface MeetingSelf extends MeetingParticipant {
  enableAudio?(): Promise<void>;
  disableAudio?(): Promise<void>;
  enableVideo?(): Promise<void>;
  disableVideo?(): Promise<void>;

  enableScreenShare?(): Promise<void>;
  disableScreenShare?(): Promise<void>;
  updateScreenshareConstraints?(constraints: MediaTrackConstraints): Promise<void>;

  getAllDevices?(): Promise<MediaDeviceInfo[]>;
  getCurrentDevices?(): CurrentDevices | undefined;
  setDevice?(device: MediaDeviceInfo): Promise<void>;

  /** Virtual-background middleware, supplied by `@cloudflare/realtimekit-virtual-background`. */
  addVideoMiddleware?(middleware: VideoMiddleware): void;
  removeVideoMiddleware?(middleware: VideoMiddleware): void;
}

/** An observable participant collection (`joined`, `waitlisted`, …). */
export interface ParticipantCollection {
  toArray?(): MeetingParticipant[];
  on?(event: string, handler: () => void): unknown;
  off?(event: string, handler: () => void): unknown;
}

export interface MeetingParticipants {
  joined?: ParticipantCollection;
  waitlisted?: ParticipantCollection;

  /** Peer id of the most recent active speaker; seeds state before the first event. */
  lastActiveSpeaker?: string | null;

  on?(event: 'broadcastedMessage', handler: (msg: BroadcastMessage) => void): unknown;
  on?(event: string, handler: () => void): unknown;
  off?(event: 'broadcastedMessage', handler: (msg: BroadcastMessage) => void): unknown;
  off?(event: string, handler: () => void): unknown;
  /** Fan a message out to every peer. RTK echoes it back to the sender too. */
  broadcastMessage?(type: string, payload: Record<string, unknown>): unknown;

  // RTK returns `void` from the waiting-room calls in some minors and a promise
  // in others; every call site awaits, which is correct either way.
  acceptWaitingRoomRequest?(id: string): void | Promise<void>;
  rejectWaitingRoomRequest?(id: string): void | Promise<void>;
  acceptAllWaitingRoomRequest?(ids: string[]): void | Promise<void>;

  disableAllAudio?(allowUnmute?: boolean): void | Promise<void>;
  disableAllVideo?(allowUnmute?: boolean): void | Promise<void>;
}

/** The slice of the RealtimeKit client this package uses. */
export interface MeetingClient {
  self: MeetingSelf;
  participants: MeetingParticipants;
  ai?: MeetingAi;
  leave?(): Promise<void>;
}
