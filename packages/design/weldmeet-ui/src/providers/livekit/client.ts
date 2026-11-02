/**
 * A LiveKit room behind the RealtimeKit client surface the WeldMeet UI is
 * written against (`meeting.self`, `meeting.participants.joined` /
 * `.waitlisted`, `broadcastMessage`, `join()`, `leave()` and their events),
 * so the same call UI, platform contexts and meeting portal run on the
 * Kubernetes editions' LiveKit server. Global never loads this file.
 *
 * How RealtimeKit's ideas map onto LiveKit:
 * - a peer's `id` (and `userId`) is its LiveKit identity, which is also the
 *   participant id the meet API stored for it (`cfSessionId`), so
 *   server-side kicks and the webhook line up;
 * - tracks are the published microphone, camera, screen share and screen
 *   share audio; "enabled" means published, subscribed and not muted;
 * - `broadcastMessage` rides on reliable data packets (topic
 *   `weldsuite.broadcast`), which carry hand raises, host-control updates
 *   and the meeting tools exactly as RealtimeKit's broadcasts do;
 * - the waiting room is a participant attribute ([`WAITING_ATTRIBUTE`]) set by
 *   the guest's token, which grants nothing until a host admits them
 *   (`LiveKitRoomService.admit`); a waiting peer is listed in `waitlisted`;
 * - `roomLeft` states follow LiveKit's disconnect reasons: removed by the
 *   server = `kicked` (or `rejected` while waiting), room closed = `ended`,
 *   a dropped connection = `disconnected` until LiveKit reconnects;
 * - media scores are LiveKit's connection quality (excellent 9, good 7,
 *   poor 3, lost 0).
 *
 * Not on LiveKit (RealtimeKit features the UI hides on these editions):
 * recording, live transcription and captions, polls, live streaming and
 * video middlewares (virtual backgrounds).
 */

import {
  ConnectionQuality,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client';
import { Emitter } from './emitter';
import { LiveKitRoomService } from './room-service';
import {
  CUSTOM_ID_ATTRIBUTE,
  WAITING_ATTRIBUTE,
  parseMetadata,
  readLiveKitToken,
  type LiveKitTokenClaims,
} from './token';

/** Data packets of `broadcastMessage` travel under this topic. */
export const BROADCAST_TOPIC = 'weldsuite.broadcast';

export type RoomState = 'init' | 'joined' | 'waitlisted' | 'left';
type PermissionState = 'NOT_REQUESTED' | 'ACCEPTED' | 'DENIED';

const SCORES: Partial<Record<ConnectionQuality, number>> = {
  [ConnectionQuality.Excellent]: 9,
  [ConnectionQuality.Good]: 7,
  [ConnectionQuality.Poor]: 3,
  [ConnectionQuality.Lost]: 0,
};

/** RealtimeKit's `roomLeft` state for a LiveKit disconnect. */
export function roomLeftState(reason: DisconnectReason | undefined, wasWaiting: boolean): string {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return 'left';
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.DUPLICATE_IDENTITY:
      return wasWaiting ? 'rejected' : 'kicked';
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return 'ended';
    default:
      return 'failed';
  }
}

function publication(p: Participant, source: Track.Source): TrackPublication | undefined {
  return p.getTrackPublication(source);
}

function trackOf(p: Participant, source: Track.Source): MediaStreamTrack | null {
  return publication(p, source)?.track?.mediaStreamTrack ?? null;
}

function isOn(p: Participant, source: Track.Source): boolean {
  const pub = publication(p, source);
  return !!pub && !pub.isMuted && !!pub.track;
}

function isWaiting(p: Participant): boolean {
  return p.attributes?.[WAITING_ATTRIBUTE] === 'true';
}

function pictureOf(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.picture === 'string' && metadata.picture ? metadata.picture : undefined;
}

/** A remote participant, shaped like RealtimeKit's `RTKParticipant`. */
export class LiveKitPeer {
  constructor(
    private readonly meeting: LiveKitMeeting,
    readonly participant: RemoteParticipant,
  ) {}

  get id(): string {
    return this.participant.identity;
  }
  get userId(): string {
    return this.participant.identity;
  }
  get name(): string {
    return this.participant.name || this.participant.identity;
  }
  get customParticipantId(): string | undefined {
    const metadata = parseMetadata(this.participant.metadata);
    const fromMeta = typeof metadata.customParticipantId === 'string' ? metadata.customParticipantId : undefined;
    return this.participant.attributes?.[CUSTOM_ID_ATTRIBUTE] ?? fromMeta;
  }
  get picture(): string | undefined {
    return pictureOf(parseMetadata(this.participant.metadata));
  }
  get audioEnabled(): boolean {
    return isOn(this.participant, Track.Source.Microphone);
  }
  get videoEnabled(): boolean {
    return isOn(this.participant, Track.Source.Camera);
  }
  get screenShareEnabled(): boolean {
    return isOn(this.participant, Track.Source.ScreenShare);
  }
  get audioTrack(): MediaStreamTrack | null {
    return trackOf(this.participant, Track.Source.Microphone);
  }
  get videoTrack(): MediaStreamTrack | null {
    return trackOf(this.participant, Track.Source.Camera);
  }
  get screenShareTracks(): { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } {
    return {
      audio: trackOf(this.participant, Track.Source.ScreenShareAudio),
      video: trackOf(this.participant, Track.Source.ScreenShare),
    };
  }
  get isPinned(): boolean {
    return this.meeting.participants.pinnedId === this.id;
  }
  get waiting(): boolean {
    return isWaiting(this.participant);
  }

  async pin(): Promise<void> {
    this.meeting.participants.setPinned(this.id);
  }
  async unpin(): Promise<void> {
    if (this.isPinned) this.meeting.participants.setPinned(null);
  }
  async kick(): Promise<void> {
    await this.meeting.roomService().removeParticipant(this.id);
  }
  async disableAudio(): Promise<void> {
    await this.mute(Track.Source.Microphone);
  }
  async disableVideo(): Promise<void> {
    await this.mute(Track.Source.Camera);
  }

  private async mute(source: Track.Source): Promise<void> {
    const pub = publication(this.participant, source);
    if (!pub || pub.isMuted) return;
    await this.meeting.roomService().mutePublishedTrack(this.id, pub.trackSid);
  }
}

/** `participants.joined` / `.waitlisted`: a peer map that emits as RealtimeKit's does. */
export class LiveKitPeerMap extends Emitter {
  private readonly peers = new Map<string, LiveKitPeer>();

  toArray(): LiveKitPeer[] {
    return [...this.peers.values()];
  }
  get(id: string): LiveKitPeer | undefined {
    return this.peers.get(id);
  }
  has(id: string): boolean {
    return this.peers.has(id);
  }
  get size(): number {
    return this.peers.size;
  }
  values(): IterableIterator<LiveKitPeer> {
    return this.peers.values();
  }

  /** @internal */
  add(peer: LiveKitPeer): void {
    if (this.peers.has(peer.id)) return;
    this.peers.set(peer.id, peer);
    this.emit('participantJoined', peer);
  }
  /** @internal */
  remove(id: string): LiveKitPeer | undefined {
    const peer = this.peers.get(id);
    if (!peer) return undefined;
    this.peers.delete(id);
    this.emit('participantLeft', peer);
    return peer;
  }
  /** @internal */
  clear(): void {
    this.peers.clear();
    this.emit('participantsCleared');
  }
}

/** `meeting.participants`. */
export class LiveKitParticipants extends Emitter {
  readonly joined = new LiveKitPeerMap();
  readonly waitlisted = new LiveKitPeerMap();
  /** The dominant speaker's peer id; never cleared between turns, as RealtimeKit's. */
  lastActiveSpeaker: string | undefined;
  pinnedId: string | null = null;

  constructor(private readonly meeting: LiveKitMeeting) {
    super();
  }

  async broadcastMessage(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.meeting.publishBroadcast(type, payload);
  }

  async acceptWaitingRoomRequest(id: string): Promise<void> {
    await this.meeting.roomService().admit(id);
  }
  async acceptAllWaitingRoomRequest(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.meeting.roomService().admit(id)));
  }
  async rejectWaitingRoomRequest(id: string): Promise<void> {
    await this.meeting.roomService().removeParticipant(id);
  }
  async disableAllAudio(_allowUnmute?: boolean): Promise<void> {
    await Promise.all(this.joined.toArray().map((peer) => peer.disableAudio()));
  }
  async disableAllVideo(): Promise<void> {
    await Promise.all(this.joined.toArray().map((peer) => peer.disableVideo()));
  }

  /** @internal */
  setPinned(id: string | null): void {
    this.pinnedId = id;
    this.emit('pinnedParticipantUpdate', id);
  }
}

/** `meeting.self`: the local participant, shaped like RealtimeKit's `RTKSelf`. */
export class LiveKitSelf extends Emitter {
  readonly mediaPermissions: { audio: PermissionState; video: PermissionState } = {
    audio: 'NOT_REQUESTED',
    video: 'NOT_REQUESTED',
  };
  /** RealtimeKit's per-preset permissions; none of its polls/livestream exist here. */
  readonly permissions: Record<string, unknown> = {};
  private devices: MediaDeviceInfo[] = [];

  constructor(private readonly meeting: LiveKitMeeting) {
    super();
  }

  private get local() {
    return this.meeting.room.localParticipant;
  }

  get id(): string {
    return this.meeting.claims.identity;
  }
  get userId(): string {
    return this.meeting.claims.identity;
  }
  get name(): string {
    return this.local.name || this.meeting.claims.name || this.id;
  }
  get customParticipantId(): string | undefined {
    const { attributes, metadata } = this.meeting.claims;
    const fromMeta = typeof metadata.customParticipantId === 'string' ? metadata.customParticipantId : undefined;
    return attributes[CUSTOM_ID_ATTRIBUTE] ?? fromMeta;
  }
  get picture(): string | undefined {
    return pictureOf(this.meeting.claims.metadata);
  }
  get roomState(): RoomState {
    return this.meeting.roomState;
  }
  get roomJoined(): boolean {
    return this.meeting.roomState === 'joined';
  }
  get audioEnabled(): boolean {
    return isOn(this.local, Track.Source.Microphone);
  }
  get videoEnabled(): boolean {
    return isOn(this.local, Track.Source.Camera);
  }
  get screenShareEnabled(): boolean {
    return isOn(this.local, Track.Source.ScreenShare);
  }
  get audioTrack(): MediaStreamTrack | null {
    return trackOf(this.local, Track.Source.Microphone);
  }
  get videoTrack(): MediaStreamTrack | null {
    return trackOf(this.local, Track.Source.Camera);
  }
  get rawAudioTrack(): MediaStreamTrack | undefined {
    return this.audioTrack ?? undefined;
  }
  get rawVideoTrack(): MediaStreamTrack | undefined {
    return this.videoTrack ?? undefined;
  }
  get screenShareTracks(): { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } {
    return {
      audio: trackOf(this.local, Track.Source.ScreenShareAudio),
      video: trackOf(this.local, Track.Source.ScreenShare),
    };
  }

  async enableAudio(): Promise<void> {
    if (this.meeting.roomState === 'waitlisted') {
      this.meeting.wanted.audio = true;
      return;
    }
    await this.withPermission('audio', () =>
      this.local.setMicrophoneEnabled(true, this.meeting.audioCaptureOptions()),
    );
  }
  async disableAudio(): Promise<void> {
    this.meeting.wanted.audio = false;
    await this.local.setMicrophoneEnabled(false);
  }
  async enableVideo(): Promise<void> {
    if (this.meeting.roomState === 'waitlisted') {
      this.meeting.wanted.video = true;
      return;
    }
    await this.withPermission('video', () => this.local.setCameraEnabled(true));
  }
  async disableVideo(): Promise<void> {
    this.meeting.wanted.video = false;
    await this.local.setCameraEnabled(false);
  }
  async enableScreenShare(): Promise<void> {
    await this.local.setScreenShareEnabled(true, { audio: true, contentHint: 'detail' });
  }
  async disableScreenShare(): Promise<void> {
    await this.local.setScreenShareEnabled(false);
  }
  async updateScreenshareConstraints(constraints: MediaTrackConstraints): Promise<void> {
    await this.screenShareTracks.video?.applyConstraints(constraints);
  }

  async getAllDevices(): Promise<MediaDeviceInfo[]> {
    this.devices = await Room.getLocalDevices(undefined, false);
    return this.devices;
  }
  getCurrentDevices(): { audio?: MediaDeviceInfo; video?: MediaDeviceInfo; speaker?: MediaDeviceInfo } {
    const find = (kind: MediaDeviceKind) => {
      const id = this.meeting.room.getActiveDevice(kind);
      return this.devices.find((d) => d.kind === kind && d.deviceId === id);
    };
    return { audio: find('audioinput'), video: find('videoinput'), speaker: find('audiooutput') };
  }
  async setDevice(device: MediaDeviceInfo): Promise<void> {
    await this.meeting.room.switchActiveDevice(device.kind, device.deviceId);
    this.emit('deviceUpdate', { device });
  }

  /** Video middlewares (virtual backgrounds) are RealtimeKit's; not on LiveKit. */
  async addVideoMiddleware(): Promise<never> {
    throw new Error('Background effects are not available on this video provider');
  }
  async removeVideoMiddleware(): Promise<void> {
    /* nothing was added */
  }

  private async withPermission(kind: 'audio' | 'video', enable: () => Promise<unknown>): Promise<void> {
    try {
      await enable();
      this.setPermission(kind, 'ACCEPTED');
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') this.setPermission(kind, 'DENIED');
      throw err;
    }
  }

  private setPermission(kind: 'audio' | 'video', state: PermissionState): void {
    if (this.mediaPermissions[kind] === state) return;
    this.mediaPermissions[kind] = state;
    this.emit('mediaPermissionUpdate', { kind, message: state });
  }
}

export interface LiveKitMeetingOptions {
  /** The LiveKit server (`wss://…`), `/config.json`'s `videoUrl`. */
  url: string;
  /** The join token the meet API handed out (its `authToken`). */
  token: string;
  /** What to send once in the room (RealtimeKit's `defaults.audio` / `.video`). */
  defaults?: { audio?: boolean; video?: boolean };
  /**
   * The browser's own noise suppression on the microphone. Off when the
   * caller runs RNNoise on it (the `getUserMedia` patch of
   * `@weldsuite/df3-noise-suppression`, which LiveKit's capture goes through
   * as RealtimeKit's does).
   */
  noiseSuppression?: boolean;
  /** For tests: the room to drive, and how the host's admin calls are sent. */
  room?: Room;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}

/** The meeting client: what `RealtimeKitClient.init` returns, on LiveKit. */
export class LiveKitMeeting {
  readonly room: Room;
  readonly claims: LiveKitTokenClaims;
  readonly self: LiveKitSelf;
  readonly participants: LiveKitParticipants;
  /** What the user wants to send; applied on join and when a waiting guest is let in. */
  readonly wanted: { audio: boolean; video: boolean };
  roomState: RoomState = 'init';
  private service: LiveKitRoomService | null = null;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private leaving = false;

  constructor(private readonly options: LiveKitMeetingOptions) {
    this.claims = readLiveKitToken(options.token);
    this.wanted = { audio: options.defaults?.audio ?? true, video: options.defaults?.video ?? true };
    this.room =
      options.room ??
      new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: this.audioCaptureOptions(),
        publishDefaults: { screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 } },
      });
    this.self = new LiveKitSelf(this);
    this.participants = new LiveKitParticipants(this);
    this.wire();
  }

  /** @internal */
  audioCaptureOptions(): { noiseSuppression: boolean; echoCancellation: boolean; autoGainControl: boolean } {
    return { noiseSuppression: this.options.noiseSuppression !== false, echoCancellation: true, autoGainControl: true };
  }

  /** The host's room administration; throws for anyone the token doesn't make an admin. */
  roomService(): LiveKitRoomService {
    if (!this.claims.roomAdmin || !this.claims.room) {
      throw new Error('Only the host can manage participants in this meeting');
    }
    this.service ??= new LiveKitRoomService(this.options.url, this.options.token, this.claims.room, this.options.fetchImpl);
    return this.service;
  }

  /** Connect, then publish what `defaults` asked for (unless waiting to be let in). */
  async join(): Promise<void> {
    this.leaving = false;
    await this.room.connect(this.options.url, this.options.token, { autoSubscribe: true });
    for (const participant of this.room.remoteParticipants.values()) this.track(participant);
    // The server's view of this participant, else what the token asked for.
    const local = this.room.localParticipant;
    const waiting = Object.keys(local.attributes ?? {}).length > 0
      ? isWaiting(local)
      : this.claims.attributes[WAITING_ATTRIBUTE] === 'true';
    if (waiting) {
      this.roomState = 'waitlisted';
      this.self.emit('waitlisted');
      return;
    }
    await this.enterRoom(false);
  }

  /** Leave the room (RealtimeKit's `leave()`); `roomLeft` fires with state `left`. */
  async leave(): Promise<void> {
    this.leaving = true;
    await this.room.disconnect(true);
  }

  /** @internal */
  async publishBroadcast(type: string, payload: Record<string, unknown>): Promise<void> {
    const data = this.encoder.encode(JSON.stringify({ type, payload, timestamp: Date.now() }));
    await this.room.localParticipant.publishData(data, { reliable: true, topic: BROADCAST_TOPIC });
  }

  private async enterRoom(reconnected: boolean): Promise<void> {
    this.roomState = 'joined';
    await this.publishWanted();
    this.self.emit('roomJoined', { reconnected });
  }

  private async publishWanted(): Promise<void> {
    const local = this.room.localParticipant;
    const tasks: Promise<unknown>[] = [];
    if (this.wanted.audio) tasks.push(this.self.enableAudio().catch((err: unknown) => this.mediaFailed('microphone', err)));
    if (this.wanted.video) tasks.push(this.self.enableVideo().catch((err: unknown) => this.mediaFailed('camera', err)));
    await Promise.all(tasks);
    // Joined with a device off: report it as RealtimeKit's join does.
    if (!this.wanted.audio) this.self.emit('audioUpdate', { audioEnabled: false, audioTrack: null });
    if (!this.wanted.video && !local.isCameraEnabled) this.self.emit('videoUpdate', { videoEnabled: false, videoTrack: null });
  }

  private mediaFailed(what: string, err: unknown): void {
    console.warn(`[WeldMeet:LiveKit] could not start the ${what}:`, err);
  }

  private peerOf(participant: Participant): LiveKitPeer | undefined {
    const id = participant.identity;
    return this.participants.joined.get(id) ?? this.participants.waitlisted.get(id);
  }

  /** Lists a remote participant under `joined` or `waitlisted`, moving them when that changes. */
  private track(participant: RemoteParticipant): void {
    const { joined, waitlisted } = this.participants;
    const peer = this.peerOf(participant) ?? new LiveKitPeer(this, participant);
    if (isWaiting(participant)) {
      if (joined.has(peer.id)) joined.remove(peer.id);
      waitlisted.add(peer);
    } else {
      if (waitlisted.has(peer.id)) waitlisted.remove(peer.id);
      joined.add(peer);
    }
  }

  private emitMedia(participant: Participant, source: Track.Source | undefined): void {
    const isLocal = participant.identity === this.room.localParticipant.identity;
    const target: Emitter = isLocal ? this.self : this.participants.joined;
    const subject = isLocal ? this.self : this.peerOf(participant);
    if (!subject) return;
    const extra = isLocal ? [] : [subject];
    switch (source) {
      case Track.Source.Microphone:
        target.emit('audioUpdate', { audioEnabled: subject.audioEnabled, audioTrack: subject.audioTrack }, ...extra);
        break;
      case Track.Source.Camera:
        target.emit('videoUpdate', { videoEnabled: subject.videoEnabled, videoTrack: subject.videoTrack }, ...extra);
        break;
      case Track.Source.ScreenShare:
      case Track.Source.ScreenShareAudio:
        target.emit(
          'screenShareUpdate',
          { screenShareEnabled: subject.screenShareEnabled, screenShareTracks: subject.screenShareTracks },
          ...extra,
        );
        break;
      default:
        break;
    }
  }

  private wire(): void {
    const room = this.room;
    const media = (pub: TrackPublication | undefined, participant: Participant) =>
      this.emitMedia(participant, pub?.source);

    room.on(RoomEvent.ParticipantConnected, (p) => this.track(p));
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      this.participants.joined.remove(p.identity);
      this.participants.waitlisted.remove(p.identity);
      if (this.participants.pinnedId === p.identity) this.participants.setPinned(null);
    });
    room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
      if (p.identity !== room.localParticipant.identity) {
        this.track(p as RemoteParticipant);
        return;
      }
      // A host let this guest in.
      if (this.roomState === 'waitlisted' && !isWaiting(p)) void this.enterRoom(false);
    });
    room.on(RoomEvent.TrackSubscribed, (_track, pub, p) => media(pub, p));
    room.on(RoomEvent.TrackUnsubscribed, (_track, pub, p) => media(pub, p));
    room.on(RoomEvent.TrackMuted, (pub, p) => media(pub, p));
    room.on(RoomEvent.TrackUnmuted, (pub, p) => media(pub, p));
    room.on(RoomEvent.LocalTrackPublished, (pub, p) => media(pub, p));
    room.on(RoomEvent.LocalTrackUnpublished, (pub, p) => media(pub, p));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const top = speakers[0]?.identity;
      if (!top || top === this.participants.lastActiveSpeaker) return;
      this.participants.lastActiveSpeaker = top;
      this.participants.emit('activeSpeaker', { peerId: top });
    });
    room.on(RoomEvent.ConnectionQualityChanged, (quality, p) => {
      const score = SCORES[quality];
      if (score === undefined) return;
      const isLocal = p.identity === room.localParticipant.identity;
      for (const kind of ['audio', 'video']) {
        const update = { kind, isScreenshare: false, score, participantId: p.identity };
        if (isLocal) this.self.emit('mediaScoreUpdate', update);
        else this.participants.joined.emit('mediaScoreUpdate', update);
      }
    });
    room.on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
      if (topic !== BROADCAST_TOPIC) return;
      try {
        const message = JSON.parse(this.decoder.decode(payload)) as { type?: unknown; payload?: unknown; timestamp?: unknown };
        if (typeof message.type !== 'string') return;
        this.participants.emit('broadcastedMessage', {
          type: message.type,
          payload: message.payload ?? {},
          timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
          peerId: p?.identity,
        });
      } catch {
        /* not ours */
      }
    });
    room.on(RoomEvent.MediaDevicesChanged, () => {
      void this.self.getAllDevices().then(
        (devices) => this.self.emit('deviceListUpdate', { devices }),
        () => undefined,
      );
    });
    room.on(RoomEvent.Reconnecting, () => this.self.emit('roomLeft', { state: 'disconnected' }));
    room.on(RoomEvent.Reconnected, () => {
      if (this.roomState === 'joined') this.self.emit('roomJoined', { reconnected: true });
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      const wasWaiting = this.roomState === 'waitlisted';
      if (this.roomState === 'left') return;
      this.roomState = 'left';
      const state = this.leaving ? 'left' : roomLeftState(reason, wasWaiting);
      this.participants.joined.clear();
      this.participants.waitlisted.clear();
      this.self.emit('roomLeft', { state });
    });
  }
}

/**
 * Join a LiveKit room the way `RealtimeKitClient.init` sets one up: the
 * returned client is not connected yet; call `join()`. Typed as whatever
 * client surface the caller renders against (the RealtimeKit client type in
 * this package's UI), which `LiveKitMeeting` answers to.
 */
export function initLiveKitMeeting<Client = LiveKitMeeting>(options: LiveKitMeetingOptions): Client {
  return new LiveKitMeeting(options) as unknown as Client;
}
