import { describe, expect, it, vi } from 'vitest';
import { ConnectionQuality, DisconnectReason, RoomEvent, Track, type Room } from 'livekit-client';
import { BROADCAST_TOPIC, LiveKitMeeting, roomLeftState } from './client';
import { Emitter } from './emitter';
import { WAITING_ATTRIBUTE, liveKitApiBase, readLiveKitToken } from './token';

/** An unsigned token with these claims (the client only reads them). */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.sig`;
}

const HOST = token({
  sub: 'user_host~a1',
  name: 'Hanna Host',
  metadata: JSON.stringify({ customParticipantId: 'user_host', picture: 'https://img/h.png' }),
  attributes: { customParticipantId: 'user_host' },
  video: { room: 'ws-room', roomJoin: true, roomAdmin: true, canPublish: true, canSubscribe: true, canPublishData: true },
});
const MEMBER = token({
  sub: 'user_m~b2',
  name: 'Max',
  attributes: { customParticipantId: 'user_m' },
  video: { room: 'ws-room', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
});
const WAITING_GUEST = token({
  sub: 'guest~c3',
  name: 'Gina',
  attributes: { customParticipantId: 'guest', [WAITING_ATTRIBUTE]: 'true' },
  video: { room: 'ws-room', roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: false },
});

/** A publication as LiveKit has one: a source, a track once subscribed, a mute flag. */
function pub(source: Track.Source, muted = false) {
  return { source, isMuted: muted, trackSid: `TR_${source}`, track: { mediaStreamTrack: { id: `mst-${source}` } } };
}

/** A participant with the parts the adapter reads. */
function participant(identity: string, attributes: Record<string, string> = {}) {
  const pubs = new Map<Track.Source, ReturnType<typeof pub>>();
  return {
    identity,
    name: identity.split('~')[0],
    metadata: JSON.stringify({ picture: `https://img/${identity}.png` }),
    attributes,
    pubs,
    isCameraEnabled: false,
    getTrackPublication: (source: Track.Source) => pubs.get(source),
  };
}

/** Just enough of a LiveKit `Room` to drive the adapter. */
class FakeRoom extends Emitter {
  remoteParticipants = new Map<string, ReturnType<typeof participant>>();
  localParticipant: ReturnType<typeof participant> & {
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    setCameraEnabled: ReturnType<typeof vi.fn>;
    setScreenShareEnabled: ReturnType<typeof vi.fn>;
    publishData: ReturnType<typeof vi.fn>;
  };
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => {
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  });
  getActiveDevice = vi.fn(() => 'default');
  switchActiveDevice = vi.fn(async () => true);

  constructor(identity: string, attributes: Record<string, string> = {}) {
    super();
    const local = participant(identity, attributes);
    const toggle = (source: Track.Source) =>
      vi.fn(async (on: boolean) => {
        if (on) local.pubs.set(source, pub(source));
        else if (local.pubs.has(source)) local.pubs.set(source, pub(source, true));
        this.emit(RoomEvent.LocalTrackPublished, local.pubs.get(source), local);
      });
    this.localParticipant = {
      ...local,
      getTrackPublication: (source: Track.Source) => local.pubs.get(source),
      setMicrophoneEnabled: toggle(Track.Source.Microphone),
      setCameraEnabled: toggle(Track.Source.Camera),
      setScreenShareEnabled: toggle(Track.Source.ScreenShare),
      publishData: vi.fn(async () => undefined),
    };
  }

  /** A remote participant joins the room. */
  arrive(p: ReturnType<typeof participant>): void {
    this.remoteParticipants.set(p.identity, p);
    this.emit(RoomEvent.ParticipantConnected, p);
  }
}

function meeting(jwt: string, room: FakeRoom, fetchImpl?: (input: string, init: RequestInit) => Promise<Response>) {
  return new LiveKitMeeting({
    url: 'wss://lk.example.eu',
    token: jwt,
    defaults: { audio: true, video: false },
    room: room as unknown as Room,
    fetchImpl,
  });
}

describe('LiveKit join tokens', () => {
  it('reads who the holder is and what they may do', () => {
    const host = readLiveKitToken(HOST);
    expect(host).toMatchObject({ identity: 'user_host~a1', name: 'Hanna Host', room: 'ws-room', roomAdmin: true, canPublish: true });
    expect(host.metadata.picture).toBe('https://img/h.png');
    const guest = readLiveKitToken(WAITING_GUEST);
    expect(guest.roomAdmin).toBe(false);
    expect(guest.attributes[WAITING_ATTRIBUTE]).toBe('true');
    expect(() => readLiveKitToken('not-a-token')).toThrow();
  });

  it('turns the client URL into the API base', () => {
    expect(liveKitApiBase('wss://lk.example.eu/')).toBe('https://lk.example.eu');
    expect(liveKitApiBase('ws://localhost:7880')).toBe('http://localhost:7880');
  });
});

describe('LiveKitMeeting', () => {
  it('joins, sends what defaults ask for and reports it as RealtimeKit does', async () => {
    const room = new FakeRoom('user_m~b2');
    const m = meeting(MEMBER, room);
    const joined = vi.fn();
    m.self.on('roomJoined', joined);
    expect(m.self.id).toBe('user_m~b2');
    expect(m.self.customParticipantId).toBe('user_m');

    await m.join();

    expect(room.connect).toHaveBeenCalledWith('wss://lk.example.eu', MEMBER, { autoSubscribe: true });
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ noiseSuppression: true }));
    expect(room.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(joined).toHaveBeenCalledWith({ reconnected: false });
    expect(m.self.roomJoined).toBe(true);
    expect(m.self.audioEnabled).toBe(true);
    expect(m.self.audioTrack).toEqual({ id: `mst-${Track.Source.Microphone}` });
    expect(m.self.videoEnabled).toBe(false);
    expect(m.self.mediaPermissions.audio).toBe('ACCEPTED');
  });

  it('lists remote people with their tracks and re-emits their media changes', async () => {
    const room = new FakeRoom('user_m~b2');
    const m = meeting(MEMBER, room);
    await m.join();
    const onJoin = vi.fn();
    const onAudio = vi.fn();
    m.participants.joined.on('participantJoined', onJoin);
    m.participants.joined.on('audioUpdate', onAudio);

    const ann = participant('user_ann~d4', { customParticipantId: 'user_ann' });
    room.arrive(ann);
    expect(onJoin).toHaveBeenCalledTimes(1);
    const peer = m.participants.joined.toArray()[0];
    expect(peer).toMatchObject({ id: 'user_ann~d4', userId: 'user_ann~d4', customParticipantId: 'user_ann', picture: 'https://img/user_ann~d4.png' });
    expect(peer?.audioEnabled).toBe(false);

    ann.pubs.set(Track.Source.Microphone, pub(Track.Source.Microphone));
    room.emit(RoomEvent.TrackSubscribed, {}, ann.pubs.get(Track.Source.Microphone), ann);
    expect(peer?.audioEnabled).toBe(true);
    expect(onAudio).toHaveBeenCalledWith({ audioEnabled: true, audioTrack: { id: `mst-${Track.Source.Microphone}` } }, peer);

    room.emit(RoomEvent.ActiveSpeakersChanged, [ann]);
    expect(m.participants.lastActiveSpeaker).toBe('user_ann~d4');

    const scores = vi.fn();
    m.participants.joined.on('mediaScoreUpdate', scores);
    room.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Poor, ann);
    expect(scores).toHaveBeenCalledWith({ kind: 'audio', isScreenshare: false, score: 3, participantId: 'user_ann~d4' });

    const onLeft = vi.fn();
    m.participants.joined.on('participantLeft', onLeft);
    room.emit(RoomEvent.ParticipantDisconnected, ann);
    expect(onLeft).toHaveBeenCalledWith(peer);
    expect(m.participants.joined.size).toBe(0);
  });

  it('broadcasts over reliable data packets and hands received ones to the UI', async () => {
    const room = new FakeRoom('user_m~b2');
    const m = meeting(MEMBER, room);
    await m.join();
    await m.participants.broadcastMessage('call:hand-raised', { peerId: 'user_m~b2' });
    const [data, options] = room.localParticipant.publishData.mock.calls[0] ?? [];
    expect(options).toEqual({ reliable: true, topic: BROADCAST_TOPIC });
    expect(JSON.parse(new TextDecoder().decode(data))).toMatchObject({ type: 'call:hand-raised', payload: { peerId: 'user_m~b2' } });

    const received = vi.fn();
    m.participants.on('broadcastedMessage', received);
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'call:hand-lowered', payload: { peerId: 'x' }, timestamp: 5 }));
    room.emit(RoomEvent.DataReceived, bytes, participant('x'), undefined, BROADCAST_TOPIC);
    room.emit(RoomEvent.DataReceived, bytes, participant('x'), undefined, 'someone-else');
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ type: 'call:hand-lowered', payload: { peerId: 'x' }, timestamp: 5, peerId: 'x' });
  });

  it('reports why the room was left with RealtimeKit states', async () => {
    expect(roomLeftState(DisconnectReason.CLIENT_INITIATED, false)).toBe('left');
    expect(roomLeftState(DisconnectReason.PARTICIPANT_REMOVED, false)).toBe('kicked');
    expect(roomLeftState(DisconnectReason.PARTICIPANT_REMOVED, true)).toBe('rejected');
    expect(roomLeftState(DisconnectReason.ROOM_DELETED, false)).toBe('ended');
    expect(roomLeftState(DisconnectReason.SIGNAL_CLOSE, false)).toBe('failed');

    const room = new FakeRoom('user_m~b2');
    const m = meeting(MEMBER, room);
    await m.join();
    const left = vi.fn();
    const back = vi.fn();
    m.self.on('roomLeft', left);
    m.self.on('roomJoined', back);
    room.emit(RoomEvent.Reconnecting);
    room.emit(RoomEvent.Reconnected);
    expect(left).toHaveBeenLastCalledWith({ state: 'disconnected' });
    expect(back).toHaveBeenLastCalledWith({ reconnected: true });

    room.emit(RoomEvent.Disconnected, DisconnectReason.ROOM_DELETED);
    expect(left).toHaveBeenLastCalledWith({ state: 'ended' });
    expect(m.self.roomState).toBe('left');

    const leaving = meeting(MEMBER, new FakeRoom('user_m~b2'));
    await leaving.join();
    const done = vi.fn();
    leaving.self.on('roomLeft', done);
    await leaving.leave();
    expect(done).toHaveBeenCalledWith({ state: 'left' });
  });

  it('keeps a waiting guest out until a host admits them, then sends', async () => {
    const room = new FakeRoom('guest~c3', { customParticipantId: 'guest', [WAITING_ATTRIBUTE]: 'true' });
    const m = meeting(WAITING_GUEST, room);
    const waitlisted = vi.fn();
    const joined = vi.fn();
    m.self.on('waitlisted', waitlisted);
    m.self.on('roomJoined', joined);
    await m.join();
    expect(waitlisted).toHaveBeenCalled();
    expect(m.self.roomState).toBe('waitlisted');
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();

    room.localParticipant.attributes = { customParticipantId: 'guest' };
    room.emit(RoomEvent.ParticipantAttributesChanged, { [WAITING_ATTRIBUTE]: '' }, room.localParticipant);
    await vi.waitFor(() => expect(joined).toHaveBeenCalledWith({ reconnected: false }));
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.anything());

    // Turned away while waiting: rejected, not kicked.
    const turnedAway = meeting(WAITING_GUEST, new FakeRoom('guest~c3', { [WAITING_ATTRIBUTE]: 'true' }));
    await turnedAway.join();
    const left = vi.fn();
    turnedAway.self.on('roomLeft', left);
    (turnedAway.room as unknown as FakeRoom).emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    expect(left).toHaveBeenCalledWith({ state: 'rejected' });
  });

  it("lists waiting guests apart and lets the host admit, reject, mute and remove through LiveKit's room service", async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      calls.push({
        url: input,
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const room = new FakeRoom('user_host~a1');
    const m = meeting(HOST, room, fetchImpl);
    await m.join();

    const gina = participant('guest~c3', { [WAITING_ATTRIBUTE]: 'true' });
    room.arrive(gina);
    expect(m.participants.waitlisted.toArray().map((p) => p.id)).toEqual(['guest~c3']);
    expect(m.participants.joined.size).toBe(0);

    await m.participants.acceptWaitingRoomRequest('guest~c3');
    expect(calls[0]).toEqual({
      url: 'https://lk.example.eu/twirp/livekit.RoomService/UpdateParticipant',
      auth: `Bearer ${HOST}`,
      body: {
        room: 'ws-room',
        identity: 'guest~c3',
        attributes: { [WAITING_ATTRIBUTE]: '' },
        permission: { can_subscribe: true, can_publish: true, can_publish_data: true },
      },
    });
    // LiveKit then reports the attribute change: the guest moves to `joined`.
    gina.attributes = {};
    room.emit(RoomEvent.ParticipantAttributesChanged, { [WAITING_ATTRIBUTE]: '' }, gina);
    expect(m.participants.waitlisted.size).toBe(0);
    const peer = m.participants.joined.get('guest~c3');
    expect(peer).toBeDefined();

    gina.pubs.set(Track.Source.Microphone, pub(Track.Source.Microphone));
    await peer?.disableAudio();
    await peer?.kick();
    await m.participants.rejectWaitingRoomRequest('guest~z9');
    expect(calls.slice(1).map((c) => [c.url.split('/').pop(), c.body])).toEqual([
      ['MutePublishedTrack', { room: 'ws-room', identity: 'guest~c3', track_sid: `TR_${Track.Source.Microphone}`, muted: true }],
      ['RemoveParticipant', { room: 'ws-room', identity: 'guest~c3' }],
      ['RemoveParticipant', { room: 'ws-room', identity: 'guest~z9' }],
    ]);
  });

  it('refuses room administration to anyone but the host', async () => {
    const room = new FakeRoom('user_m~b2');
    const fetchImpl = vi.fn();
    const m = meeting(MEMBER, room, fetchImpl);
    await m.join();
    room.arrive(participant('user_ann~d4'));
    await expect(m.participants.joined.toArray()[0]?.kick()).rejects.toThrow(/host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
