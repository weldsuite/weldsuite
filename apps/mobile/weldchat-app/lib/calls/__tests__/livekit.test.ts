/**
 * The LiveKit side of the provider switch: what `createLiveKitCall` sets up
 * before `livekit-client` loads, the room it joins with, and call audio.
 */

const mockRegisterGlobals = jest.fn();
const mockInCallStart = jest.fn();
const mockNativeModules: { InCallManager?: { start: () => void } } = {};
const mockInitLiveKitMeeting = jest.fn();
const mockRoom = jest.fn();
/** What the globals looked like when `livekit-client` was loaded. */
const mockLoadedWith: { userAgent?: string; webrtcRegistered?: number }[] = [];

jest.mock('react-native', () => ({
  NativeModules: mockNativeModules,
  Platform: { OS: 'ios' },
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
  mockNativeModules.InCallManager = { start: mockInCallStart };
  mockInitLiveKitMeeting.mockImplementation(() => ({ kind: 'livekit-meeting' }));
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
    const meeting = createLiveKitCall(options);

    expect(meeting).toEqual({ kind: 'livekit-meeting' });
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

  it('still joins on a binary without the in-call audio module', () => {
    delete mockNativeModules.InCallManager;
    const { createLiveKitCall } = load();

    expect(createLiveKitCall(options)).toEqual({ kind: 'livekit-meeting' });
  });
});
