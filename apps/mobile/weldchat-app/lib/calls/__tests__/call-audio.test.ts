/**
 * The call audio both video providers share: who starts RealtimeKit's
 * `InCallManager`, and that it stops only when the last call lets go.
 */

const mockInCallStart = jest.fn();
const mockInCallStop = jest.fn();
const mockNativeModules: { InCallManager?: { start: () => void; stop: (...args: unknown[]) => void } } = {};
const mockPlatform = { OS: 'ios' };

jest.mock('react-native', () => ({
  NativeModules: mockNativeModules,
  Platform: mockPlatform,
}));

type CallAudioModule = typeof import('../call-audio');

function load(): CallAudioModule {
  let mod: CallAudioModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh counter per test
    mod = require('../call-audio') as CallAudioModule;
  });
  return mod as CallAudioModule;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.OS = 'ios';
  mockNativeModules.InCallManager = { start: mockInCallStart, stop: mockInCallStop };
});

describe('holdCallAudio', () => {
  it('starts the call audio for the first call and stops it when that call lets go', () => {
    const { holdCallAudio } = load();

    const release = holdCallAudio();
    expect(mockInCallStart).toHaveBeenCalledTimes(1);

    release();
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
    expect(mockInCallStop).toHaveBeenCalledWith('');
  });

  it("leaves the start to RealtimeKit's SDK when asked, and still stops", () => {
    mockPlatform.OS = 'android';
    const { holdCallAudio } = load();

    const release = holdCallAudio({ start: false });
    expect(mockInCallStart).not.toHaveBeenCalled();

    release();
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
    expect(mockInCallStop).toHaveBeenCalledWith();
  });

  it('stops only when the last call holding the audio lets go', () => {
    const { holdCallAudio } = load();
    const closing = holdCallAudio({ start: false });
    const next = holdCallAudio({ start: false });

    closing();
    expect(mockInCallStop).not.toHaveBeenCalled();

    next();
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
  });

  it('counts a release once, however often it is called', () => {
    const { holdCallAudio } = load();
    const first = holdCallAudio();
    const second = holdCallAudio();

    first();
    first();
    expect(mockInCallStop).not.toHaveBeenCalled();

    second();
    expect(mockInCallStop).toHaveBeenCalledTimes(1);
  });

  it('starts the audio again for a call after the last one gave it back', () => {
    const { holdCallAudio } = load();

    holdCallAudio()();
    holdCallAudio()();

    expect(mockInCallStart).toHaveBeenCalledTimes(2);
    expect(mockInCallStop).toHaveBeenCalledTimes(2);
  });

  it('does nothing on a binary without the in-call audio module', () => {
    delete mockNativeModules.InCallManager;
    const { holdCallAudio } = load();

    expect(() => holdCallAudio()()).not.toThrow();
  });
});
