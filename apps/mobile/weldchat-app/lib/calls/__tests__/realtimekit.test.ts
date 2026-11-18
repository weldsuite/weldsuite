/**
 * Ending a WeldChat call on RealtimeKit: the phone's call audio goes back once
 * the meeting has left, however the call ended, and never from under a newer
 * call.
 *
 * The fakes follow `@cloudflare/realtimekit-react-native` 2.0: `init` starts
 * `InCallManager` while it sets up the call's media (`LocalMediaHandler`'s
 * constructor), the native `start` does nothing while started, `stop` does
 * nothing while stopped, and `leave()` ends in `roomState` 'left'.
 */

/** RealtimeKit's native `InCallManager`, with the guard both platforms' `start` and `stop` have. */
const mockInCall = {
  active: false,
  inits: 0,
  start: jest.fn(() => {
    if (mockInCall.active) return;
    mockInCall.active = true;
    mockInCall.inits += 1;
  }),
  stop: jest.fn(() => {
    mockInCall.active = false;
  }),
};
const mockPlatform = { OS: 'ios' };

jest.mock('react-native', () => ({
  NativeModules: { InCallManager: mockInCall },
  Platform: mockPlatform,
}));

type RealtimeKitModule = typeof import('../realtimekit');

function load(): RealtimeKitModule {
  let mod: RealtimeKitModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh call-audio counter per test
    mod = require('../realtimekit') as RealtimeKitModule;
  });
  return mod as RealtimeKitModule;
}

/** A RealtimeKit client: leaving takes a moment, then the room is left. */
function fakeMeeting() {
  let finishLeave: () => void = () => undefined;
  const meeting = {
    self: { roomState: 'joined' as string },
    leave: jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLeave = () => {
            meeting.self.roomState = 'left';
            resolve();
          };
        }),
    ),
    /** Lets the pending `leave()` finish. */
    finishLeave: () => finishLeave(),
  };
  return meeting;
}

/** `useRealtimeKitClient`'s `init`: sets the media up (starting the call audio), then hands the client over. */
function sdkInit(meeting: ReturnType<typeof fakeMeeting>) {
  return jest.fn(async () => {
    mockInCall.start();
    return meeting;
  });
}

/** Let every pending promise callback run. */
function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInCall.active = false;
  mockInCall.inits = 0;
  mockPlatform.OS = 'ios';
});

describe('ending a RealtimeKit call', () => {
  it('leaves the start to the SDK', async () => {
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();

    const call = startRealtimeKitCall(sdkInit(meeting));

    await expect(call.meeting).resolves.toBe(meeting);
    expect(mockInCall.start).toHaveBeenCalledTimes(1);
  });

  it('gives the audio back after a hang-up, without leaving twice', async () => {
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();
    const call = startRealtimeKitCall(sdkInit(meeting));
    await call.meeting;

    // The call host hangs up: it leaves, then the session ends and it unmounts.
    const hangUp = meeting.leave();
    meeting.finishLeave();
    await hangUp;
    await call.end();

    expect(meeting.leave).toHaveBeenCalledTimes(1);
    expect(mockInCall.active).toBe(false);
    // iOS's native stop takes the busy tone to play (none).
    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
    expect(mockInCall.stop).toHaveBeenCalledWith('');
  });

  it("calls Android's stop with no arguments (the bridge checks the count)", async () => {
    mockPlatform.OS = 'android';
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();
    meeting.self.roomState = 'left';
    const call = startRealtimeKitCall(sdkInit(meeting));

    await call.end();

    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
    expect(mockInCall.stop).toHaveBeenCalledWith();
  });

  it('leaves a call ended elsewhere, and gives the audio back only once it has left', async () => {
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();
    const call = startRealtimeKitCall(sdkInit(meeting));
    await call.meeting;

    // The other side or the server ended it: the host unmounts while still in the room.
    const ending = call.end();
    await settle();
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    // iOS stops whatever still plays into an audio session it deactivates.
    expect(mockInCall.stop).not.toHaveBeenCalled();

    meeting.finishLeave();
    await ending;
    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
    expect(mockInCall.active).toBe(false);
  });

  it('gives the audio back when the room is gone already', async () => {
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();
    meeting.leave.mockRejectedValueOnce(new Error('not in a room'));
    const call = startRealtimeKitCall(sdkInit(meeting));

    await call.end();

    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
  });

  it('gives the audio back when set-up failed after the SDK started it', async () => {
    const { startRealtimeKitCall } = load();
    const init = jest.fn(async () => {
      mockInCall.start();
      throw new Error('join token expired');
    });
    const call = startRealtimeKitCall(init);

    await expect(call.meeting).rejects.toThrow('join token expired');
    await call.end();

    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
    expect(mockInCall.active).toBe(false);
  });

  it('waits for a set-up still under way, then leaves that meeting before giving the audio back', async () => {
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();
    meeting.self.roomState = 'init';
    let setUp: () => void = () => undefined;
    const init = jest.fn(
      () =>
        new Promise<typeof meeting>((resolve) => {
          setUp = () => {
            mockInCall.start();
            resolve(meeting);
          };
        }),
    );
    const call = startRealtimeKitCall(init);

    // Hung up while still connecting: nobody got the meeting to leave it.
    const ending = call.end();
    await settle();
    expect(mockInCall.stop).not.toHaveBeenCalled();

    setUp();
    await settle();
    expect(meeting.leave).toHaveBeenCalledTimes(1);
    meeting.finishLeave();
    await ending;
    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
    expect(mockInCall.active).toBe(false);
  });

  it('gives the audio back when RealtimeKit had no client for this set-up', async () => {
    const { startRealtimeKitCall } = load();
    const call = startRealtimeKitCall(async () => undefined);

    await call.end();

    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
  });

  it('ends a call once, however often it is ended', async () => {
    const { startRealtimeKitCall } = load();
    const meeting = fakeMeeting();
    const call = startRealtimeKitCall(sdkInit(meeting));

    const ending = Promise.all([call.end(), call.end()]);
    await settle();
    meeting.finishLeave();
    await ending;
    await call.end();

    expect(meeting.leave).toHaveBeenCalledTimes(1);
    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
  });
});

describe('the next RealtimeKit call', () => {
  it('keeps the audio while a newer call is starting', async () => {
    const { startRealtimeKitCall } = load();
    const first = fakeMeeting();
    const second = fakeMeeting();
    const firstCall = startRealtimeKitCall(sdkInit(first));
    await firstCall.meeting;

    // The first call is still leaving when the next one starts setting up: the
    // SDK has started the call audio (a no-op, it is on) and is still at it
    // when the first call's leave finishes.
    const firstEnding = firstCall.end();
    let setUp: () => void = () => undefined;
    const secondCall = startRealtimeKitCall(
      () =>
        new Promise<typeof second>((resolve) => {
          mockInCall.start();
          setUp = () => resolve(second);
        }),
    );
    await settle();
    first.finishLeave();
    await firstEnding;

    expect(mockInCall.stop).not.toHaveBeenCalled();
    expect(mockInCall.active).toBe(true);
    setUp();
    await secondCall.meeting;

    second.self.roomState = 'left';
    await secondCall.end();
    expect(mockInCall.stop).toHaveBeenCalledTimes(1);
    expect(mockInCall.active).toBe(false);
  });

  it('gets the call audio set up again after the last call gave it back', async () => {
    const { startRealtimeKitCall } = load();
    const first = fakeMeeting();
    first.self.roomState = 'left';
    const firstCall = startRealtimeKitCall(sdkInit(first));
    await firstCall.meeting;
    await firstCall.end();
    expect(mockInCall.active).toBe(false);

    const second = fakeMeeting();
    const secondCall = startRealtimeKitCall(sdkInit(second));
    await secondCall.meeting;

    // The SDK's start for the next call sets the audio up again, not a no-op.
    expect(mockInCall.inits).toBe(2);
    expect(mockInCall.active).toBe(true);
  });
});
