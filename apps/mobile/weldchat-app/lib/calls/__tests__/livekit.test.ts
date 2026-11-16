/**
 * The LiveKit side of the provider switch: what `createLiveKitCall` sets up
 * before `livekit-client` loads, the room it joins with, and the in-call
 * audio session it holds until the call ends.
 */

const mockRegisterGlobals = jest.fn();
const mockInCallStart = jest.fn();
const mockInCallStop = jest.fn();
const mockNativeModules: { InCallManager?: { start: () => void; stop: (...args: unknown[]) => void } } = {};
const mockPlatform = { OS: 'ios' };
const mockLeave = jest.fn();
/** What `initLiveKitMeeting` hands back: the client the call host joins with. */
const mockMeeting = { kind: 'livekit-meeting', leave: mockLeave };
const mockInitLiveKitMeeting = jest.fn();
const mockRoom = jest.fn();
/** What the globals looked like when `livekit-client` was loaded. */
const mockLoadedWith: { userAgent?: string; webrtcRegistered?: number }[] = [];

jest.mock('react-native', () => ({
  NativeModules: mockNativeModules,
  Platform: mockPlatform,
  PixelRatio: { get: () => 3 },
}));
jest.mock('@cloudflare/react-native-webrtc', () => ({ registerGlobals: () => mockRegisterGlobals() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-from-expo-crypto' }));
jest.mock('livekit-client', () => {
  mockLoadedWith.push({
    userAgent: (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent,
    webrtcRegistered: mockRegisterGlobals.mock.calls.length,
  });
  return {
    Room: function Room(this: { options: unknown }, options: unknown) {
      mockRoom(options);
      this.options = options;
    },
  };
});
jest.mock('@weldsuite/weldmeet-ui/providers/livekit', () => ({
  initLiveKitMeeting: (options: unknown) => mockInitLiveKitMeeting(options),
}));

/** RealtimeKit's SDK reports this user agent when it loads (a desktop Chrome on macOS). */
const REALTIMEKIT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4753.0 Safari/537.36';

type LiveKitModule = typeof import('../livekit');

function load(): LiveKitModule {
  let mod: LiveKitModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh copy per test (module state)
    mod = require('../livekit') as LiveKitModule;
  });
  return mod as LiveKitModule;
}

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadedWith.length = 0;
  mockPlatform.OS = 'ios';
  mockNativeModules.InCallManager = { start: mockInCallStart, stop: mockInCallStop };
  mockLeave.mockResolvedValue(undefined);
  mockInitLiveKitMeeting.mockImplementation(() => mockMeeting);
  Object.defineProperty(globalThis, 'navigator', {
    value: { product: 'ReactNative', userAgent: REALTIMEKIT_UA },
    configurable: true,
    writable: true,
  });
  delete (globalThis as { LiveKitReactNativeGlobal?: unknown }).LiveKitReactNativeGlobal;
});

afterAll(() => {
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
  if (realCrypto) Object.defineProperty(globalThis, 'crypto', realCrypto);
});

describe('ensureLiveKitGlobals', () => {
  it('sets up what livekit-client needs in React Native, once', () => {
    const { ensureLiveKitGlobals } = load();
    ensureLiveKitGlobals();
    ensureLiveKitGlobals();

    expect(mockRegisterGlobals).toHaveBeenCalledTimes(1);
    expect((globalThis as { LiveKitReactNativeGlobal?: unknown }).LiveKitReactNativeGlobal).toEqual({
      platform: 'ios',
      devicePixelRatio: 3,
    });
  });

  it("hides RealtimeKit's browser user agent from webrtc-adapter", () => {
    const { ensureLiveKitGlobals, LIVEKIT_USER_AGENT } = load();
    ensureLiveKitGlobals();

    const ua = globalThis.navigator.userAgent;
    expect(ua).toBe(LIVEKIT_USER_AGENT);
    // webrtc-adapter patches the peer connection for a UA it reads as Chrome or Safari.
    expect(ua).not.toMatch(/AppleWebKit\/\d+\.|Chrom(e|ium)\/\d+\./);
  });

  it('adds crypto.randomUUID when the runtime has none', () => {
    const getRandomValues = jest.fn();
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues }, configurable: true, writable: true });
    const { ensureLiveKitGlobals } = load();
    ensureLiveKitGlobals();

    expect((globalThis.crypto as Crypto).randomUUID()).toBe('uuid-from-expo-crypto');
    expect(globalThis.crypto.getRandomValues).toBe(getRandomValues);
  });
});

describe('createLiveKitCall', () => {
  const options = {
    url: 'wss://livekit.eu.example.org',
    token: 'lk.jwt.token',
    defaults: { audio: true, video: false },
  };

  it('loads livekit-client only once the globals are in place', () => {
    const { createLiveKitCall, LIVEKIT_USER_AGENT } = load();
    createLiveKitCall(options);

    expect(mockLoadedWith).toEqual([{ userAgent: LIVEKIT_USER_AGENT, webrtcRegistered: 1 }]);
  });

  it("hands the token to the platform's LiveKit client with a room fit for React Native", () => {
    const { createLiveKitCall, LIVEKIT_ROOM_OPTIONS } = load();
    const { meeting } = createLiveKitCall(options);

    expect(meeting).toBe(mockMeeting);
    expect(mockRoom).toHaveBeenCalledWith(LIVEKIT_ROOM_OPTIONS);
    expect(LIVEKIT_ROOM_OPTIONS).toMatchObject({
      adaptiveStream: false,
      dynacast: false,
      publishDefaults: { simulcast: false },
    });
    expect(mockInitLiveKitMeeting).toHaveBeenCalledWith({
      url: options.url,
      token: options.token,
      defaults: options.defaults,
      room: expect.objectContaining({ options: LIVEKIT_ROOM_OPTIONS }),
    });
  });

  it('starts the in-call audio session as RealtimeKit does', () => {
    const { createLiveKitCall } = load();
    createLiveKitCall(options);

    expect(mockInCallStart).toHaveBeenCalledTimes(1);
  });

  it('leaves the audio alone when the token is not a LiveKit one', () => {
    mockInitLiveKitMeeting.mockImplementation(() => {
      throw new Error('Not a LiveKit access token');
    });
    const { createLiveKitCall } = load();

    expect(() => createLiveKitCall(options)).toThrow('Not a LiveKit access token');
    expect(mockInCallStart).not.toHaveBeenCalled();
  });

  it('still joins and ends on a binary without the in-call audio module', async () => {
    delete mockNativeModules.InCallManager;
    const { createLiveKitCall } = load();
    const call = createLiveKitCall(options);

    expect(call.meeting).toBe(mockMeeting);
    await expect(call.end()).resolves.toBeUndefined();
  });
});

describe('ending a LiveKit call', () => {
  const options = {
    url: 'wss://livekit.eu.example.org',
    token: 'lk.jwt.token',
    defaults: { audio: true, video: true },
  };

  it('hands the audio back once the room has closed', async () => {
    let closed: () => void = () => undefined;
    mockLeave.mockReturnValue(new Promise<void>((resolve) => (closed = resolve)));
    const { createLiveKitCall } = load();
    const call = createLiveKitCall(options);

    const ending = call.end();
    await Promise.resolve();
    expect(mockLeave).toHaveBeenCalledTimes(1);
    // iOS stops whatever still plays into an audio session it deactivates.
    expect(mockInCallStop).not.toHaveBeenCalled();

    closed();
    await ending;
    // iOS's native stop takes the busy tone to play (none).
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
    expect(mockInCallStop).toHaveBeenCalledWith('');
  });

  it("calls Android's stop with no arguments (the bridge checks the count)", async () => {
    mockPlatform.OS = 'android';
    const { createLiveKitCall } = load();

    await createLiveKitCall(options).end();

    expect(mockInCallStop).toHaveBeenCalledTimes(1);
    expect(mockInCallStop).toHaveBeenCalledWith();
  });

  it('ends a call once, however often it is ended', async () => {
    const { createLiveKitCall } = load();
    const call = createLiveKitCall(options);

    await Promise.all([call.end(), call.end()]);
    await call.end();

    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
  });

  it('hands the audio back when the room is gone already', async () => {
    mockLeave.mockRejectedValue(new Error('already disconnected'));
    const { createLiveKitCall } = load();

    await createLiveKitCall(options).end();

    expect(mockInCallStop).toHaveBeenCalledTimes(1);
  });

  it('keeps the audio for a new call while the last one is still closing', async () => {
    const { createLiveKitCall } = load();
    const first = createLiveKitCall(options);
    const second = createLiveKitCall(options);
    expect(mockInCallStart).toHaveBeenCalledTimes(1);

    await first.end();
    expect(mockInCallStop).not.toHaveBeenCalled();

    await second.end();
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
  });
});
