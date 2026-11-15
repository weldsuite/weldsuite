/**
 * A WeldChat call on LiveKit through the real client
 * (`@weldsuite/weldmeet-ui/providers/livekit`), driven by a fake room: the
 * events and state `CallHost` reads to join, ring back, show "Reconnecting",
 * mute, hang up when the other person or the server ends the call, and give
 * the phone its audio back afterwards.
 */

import { EventEmitter } from 'events';

/** RealtimeKit's in-call audio module. */
const mockInCallManager = { start: jest.fn(), stop: jest.fn() };

jest.mock('react-native', () => ({
  NativeModules: { InCallManager: mockInCallManager },
  Platform: { OS: 'android' },
  PixelRatio: { get: () => 2 },
}));
jest.mock('@cloudflare/react-native-webrtc', () => ({ registerGlobals: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));

/** The rooms `createLiveKitCall` built, newest last. */
const mockRooms: MockRoom[] = [];
/** End every call a test started, as the call host does when it unmounts. */
const endCalls: (() => Promise<void>)[] = [];

jest.mock('livekit-client', () => {
  const actual = jest.requireActual('livekit-client');
  return {
    ...actual,
    Room: function Room() {
      const room = new MockRoom(actual);
      mockRooms.push(room);
      return room;
    },
  };
});

type LiveKit = typeof import('livekit-client');

/** A LiveKit join token as the chat-calls API mints one (unsigned: the client only reads it). */
function chatCallToken(userId: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    sub: `${userId}~n1`,
    name: 'Bea',
    attributes: { customParticipantId: userId },
    video: { room: 'chat-dm-room', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.sig`;
}

type Pub = { source: string; isMuted: boolean; trackSid: string; track: { mediaStreamTrack: { id: string } } };

function publication(source: string, muted = false): Pub {
  return { source, isMuted: muted, trackSid: `TR_${source}`, track: { mediaStreamTrack: { id: `mst-${source}` } } };
}

function participant(identity: string) {
  const pubs = new Map<string, Pub>();
  return {
    identity,
    name: identity.split('~')[0],
    metadata: '',
    attributes: { customParticipantId: identity.split('~')[0] } as Record<string, string>,
    pubs,
    isCameraEnabled: false,
    getTrackPublication: (source: string) => pubs.get(source),
  };
}

/** Just enough of a LiveKit `Room` to drive the client. */
class MockRoom extends EventEmitter {
  remoteParticipants = new Map<string, ReturnType<typeof participant>>();
  localParticipant: ReturnType<typeof participant> & {
    setMicrophoneEnabled: jest.Mock;
    setCameraEnabled: jest.Mock;
  };
  connect = jest.fn(async () => undefined);
  disconnect = jest.fn(async () => {
    this.emit(this.lk.RoomEvent.Disconnected, this.lk.DisconnectReason.CLIENT_INITIATED);
  });

  constructor(private readonly lk: LiveKit) {
    super();
    const local = participant('pending');
    const toggle = (source: string) =>
      jest.fn(async (on: boolean) => {
        local.pubs.set(source, publication(source, !on));
        this.emit(lk.RoomEvent.LocalTrackPublished, local.pubs.get(source), this.localParticipant);
      });
    this.localParticipant = {
      ...local,
      getTrackPublication: (source: string) => local.pubs.get(source),
      setMicrophoneEnabled: toggle(lk.Track.Source.Microphone),
      setCameraEnabled: toggle(lk.Track.Source.Camera),
    };
  }
}

function setup(defaults = { audio: true, video: false }) {
  const lk = jest.requireActual('livekit-client') as LiveKit;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the navigator stub
  const { createLiveKitCall } = require('../livekit') as typeof import('../livekit');
  const { meeting, end } = createLiveKitCall<{
    self: EventEmitter & { roomJoined: boolean; audioEnabled: boolean; videoEnabled: boolean; disableAudio(): Promise<void>; enableAudio(): Promise<void> };
    participants: { joined: EventEmitter & { toArray(): { id: string }[] } };
    join(): Promise<void>;
    leave(): Promise<void>;
  }>({ url: 'wss://livekit.eu.example.org', token: chatCallToken('user_b'), defaults });
  endCalls.push(end);
  const room = mockRooms[mockRooms.length - 1];
  const events: [string, unknown][] = [];
  for (const name of ['roomJoined', 'roomLeft', 'audioUpdate']) {
    meeting.self.on(name, (payload: unknown) => events.push([name, payload]));
  }
  return { lk, meeting, end, room, events };
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { product: 'ReactNative', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/98.0.0.0' },
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  mockInCallManager.start.mockClear();
  mockInCallManager.stop.mockClear();
});

afterEach(async () => {
  await Promise.all(endCalls.splice(0).map((end) => end()));
});

describe('a WeldChat call on LiveKit', () => {
  it('answers a ring: joins the room the caller is already in, with the microphone on', async () => {
    const { meeting, room, events } = setup();
    const caller = participant('user_a~n0');
    room.remoteParticipants.set(caller.identity, caller);

    await meeting.join();

    expect(room.connect).toHaveBeenCalledWith('wss://livekit.eu.example.org', expect.any(String), { autoSubscribe: true });
    expect(meeting.self.roomJoined).toBe(true);
    expect(events).toContainEqual(['roomJoined', { reconnected: false }]);
    // The caller counts as present (no ringback, the timer starts).
    expect(meeting.participants.joined.toArray().map((p) => p.id)).toEqual(['user_a~n0']);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything());
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(meeting.self.audioEnabled).toBe(true);
  });

  it('lets the caller hear the other person arrive and leave', async () => {
    const { lk, meeting, room } = setup();
    await meeting.join();
    const seen: string[] = [];
    meeting.participants.joined.on('participantJoined', () => seen.push('joined'));
    meeting.participants.joined.on('participantLeft', () => seen.push('left'));
    const callee = participant('user_c~n2');

    room.remoteParticipants.set(callee.identity, callee);
    room.emit(lk.RoomEvent.ParticipantConnected, callee);
    expect(meeting.participants.joined.toArray()).toHaveLength(1);

    room.emit(lk.RoomEvent.ParticipantDisconnected, callee);
    expect(meeting.participants.joined.toArray()).toHaveLength(0);
    expect(seen).toEqual(['joined', 'left']);
  });

  it('mutes and unmutes the microphone', async () => {
    const { meeting, events } = setup();
    await meeting.join();

    await meeting.self.disableAudio();
    expect(meeting.self.audioEnabled).toBe(false);
    await meeting.self.enableAudio();
    expect(meeting.self.audioEnabled).toBe(true);
    expect(events.filter(([name]) => name === 'audioUpdate').length).toBeGreaterThanOrEqual(2);
  });

  it('reports a dropped connection as one being restored, not as a hang-up', async () => {
    const { lk, meeting, room, events } = setup();
    await meeting.join();

    room.emit(lk.RoomEvent.Reconnecting);
    room.emit(lk.RoomEvent.Reconnected);

    expect(events).toContainEqual(['roomLeft', { state: 'disconnected' }]);
    expect(events).toContainEqual(['roomJoined', { reconnected: true }]);
  });

  it('ends when the server closes the call', async () => {
    const { lk, meeting, room, events } = setup();
    await meeting.join();

    room.emit(lk.RoomEvent.Disconnected, lk.DisconnectReason.ROOM_DELETED);

    expect(events).toContainEqual(['roomLeft', { state: 'ended' }]);
    expect(meeting.self.roomJoined).toBe(false);
  });

  it('hangs up', async () => {
    const { meeting, room, events } = setup();
    await meeting.join();

    await meeting.leave();

    expect(room.disconnect).toHaveBeenCalledWith(true);
    expect(events).toContainEqual(['roomLeft', { state: 'left' }]);
  });

  it('holds the in-call audio for the call and gives it back after it ends', async () => {
    const { lk, meeting, end, room } = setup();
    expect(mockInCallManager.start).toHaveBeenCalledTimes(1);
    await meeting.join();

    room.emit(lk.RoomEvent.Disconnected, lk.DisconnectReason.ROOM_DELETED);
    expect(mockInCallManager.stop).not.toHaveBeenCalled();

    await end();
    expect(mockInCallManager.stop).toHaveBeenCalledTimes(1);
    expect(mockInCallManager.stop).toHaveBeenCalledWith();
  });
});
