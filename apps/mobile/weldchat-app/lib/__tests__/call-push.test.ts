import {
  callPushData,
  incomingFromNativePayload,
  isCallPushFromThisServer,
  nativePayloadFromIncoming,
  parseCallPush,
} from '../call-push';

const ring = {
  notificationType: 'chat_call_ring',
  callId: 'call_1',
  entityId: 'call_1',
  chatChannelId: 'ch_1',
  callType: 'video',
  callerName: 'Alice',
  declineToken: 'tok.sig',
  expiresAt: '1700000060000',
  actionUrl: '/weldchat/dm/ch_1',
};

describe('callPushData', () => {
  it('reads the JSON string Expo hands the background task', () => {
    expect(callPushData({ data: { dataString: JSON.stringify(ring) }, notification: null })).toEqual(ring);
    expect(callPushData({ data: { body: JSON.stringify(ring) } })).toEqual(ring);
  });

  it('reads plain keys', () => {
    expect(callPushData({ data: ring })).toEqual(ring);
  });

  it('ignores a notification response (a tap) and junk', () => {
    expect(callPushData({ actionIdentifier: 'default', notification: {} })).toBeNull();
    expect(callPushData(null)).toBeNull();
    expect(callPushData({ data: 'nope' })).toBeNull();
  });
});

describe('parseCallPush', () => {
  it('parses a ring into the native payload', () => {
    expect(parseCallPush(ring)).toEqual({
      kind: 'ring',
      payload: {
        callId: 'call_1',
        channelId: 'ch_1',
        callType: 'video',
        callerName: 'Alice',
        declineToken: 'tok.sig',
        expiresAt: '1700000060000',
      },
    });
  });

  it('falls back to entityId for the call id', () => {
    const { callId: _omit, ...withoutCallId } = ring;
    expect(parseCallPush(withoutCallId)).toMatchObject({ kind: 'ring', payload: { callId: 'call_1' } });
  });

  it('parses a cancel', () => {
    expect(parseCallPush({ notificationType: 'chat_call_cancel', callId: 'call_1', reason: 'answered' })).toEqual({
      kind: 'cancel',
      callId: 'call_1',
      reason: 'answered',
    });
  });

  it('ignores other notifications and unsafe ids', () => {
    expect(parseCallPush({ ...ring, notificationType: 'chat_incoming_call' })).toBeNull();
    expect(parseCallPush({ ...ring, callId: '../x', entityId: '../x' })).toBeNull();
    expect(parseCallPush({ ...ring, chatChannelId: '' })).toBeNull();
    expect(parseCallPush(null)).toBeNull();
  });
});

describe('payload conversion', () => {
  it('round-trips between the native payload and the app shape', () => {
    const incoming = incomingFromNativePayload({ callId: 'call_1', channelId: 'ch_1', callType: 'voice', callerName: '' });
    expect(incoming).toEqual({
      callId: 'call_1',
      channelId: 'ch_1',
      callType: 'voice',
      callerName: 'Incoming call',
      callerAvatar: undefined,
    });
    expect(nativePayloadFromIncoming(incoming!)).toEqual({
      callId: 'call_1',
      channelId: 'ch_1',
      callType: 'voice',
      callerName: 'Incoming call',
    });
  });
});

describe('isCallPushFromThisServer', () => {
  const fromEu = { ...ring, server: 'https://app.weldsuite.eu' };

  it("drops WeldSuite cloud's rings, which name no server", () => {
    expect(isCallPushFromThisServer(ring, null)).toBe(false);
    expect(isCallPushFromThisServer({ ...ring, server: '  ' }, () => true)).toBe(false);
    expect(isCallPushFromThisServer(null, null)).toBe(false);
  });

  it('takes a ring that names a server when the runtime is not booted yet (headless)', () => {
    expect(isCallPushFromThisServer(fromEu, null)).toBe(true);
  });

  it("asks the booted runtime whether it is this app's server", () => {
    const isThisServer = jest.fn((data: Record<string, unknown>) => data.server === 'https://app.weldsuite.eu');
    expect(isCallPushFromThisServer(fromEu, isThisServer)).toBe(true);
    expect(isCallPushFromThisServer({ ...ring, server: 'https://chat.example.com' }, isThisServer)).toBe(false);
    expect(isThisServer).toHaveBeenCalledTimes(2);
  });
});
