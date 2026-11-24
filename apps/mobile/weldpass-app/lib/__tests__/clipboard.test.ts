import { CLEAR_AFTER_MS, copySecret, copyText, resetClipboardForTests, type ClipboardBackends } from '@/lib/clipboard';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(), getStringAsync: jest.fn() }));
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));

/** A clipboard in memory, with timers run by hand. */
function fakeBackends(withNative: boolean) {
  let content = '';
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const native = {
    setSensitiveString: jest.fn(async (text: string) => {
      content = text;
      return 'token-1';
    }),
    clearIfUnchanged: jest.fn(async (token: string) => {
      if (token !== 'token-1') return false;
      content = '';
      return true;
    }),
  };
  const backends: ClipboardBackends = {
    native: withNative ? native : null,
    clipboard: {
      setStringAsync: jest.fn(async (text: string) => {
        content = text;
        return true;
      }),
      getStringAsync: jest.fn(async () => content),
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  };
  const runTimers = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    backends,
    native,
    runTimers,
    timers,
    get content() {
      return content;
    },
    set content(value: string) {
      content = value;
    },
  };
}

beforeEach(() => resetClipboardForTests());

describe('copying a secret', () => {
  it('marks it sensitive through the native module, which expires it after 30 s', async () => {
    const fake = fakeBackends(true);
    await copySecret('hunter2', fake.backends);
    expect(fake.native.setSensitiveString).toHaveBeenCalledWith('hunter2', 30);
    expect(fake.backends.clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(fake.timers[0]?.ms).toBe(CLEAR_AFTER_MS);

    await fake.runTimers();
    expect(fake.native.clearIfUnchanged).toHaveBeenCalledWith('token-1');
    expect(fake.content).toBe('');
  });

  it('falls back to expo-clipboard and clears only its own copy', async () => {
    const fake = fakeBackends(false);
    await copySecret('hunter2', fake.backends);
    expect(fake.content).toBe('hunter2');
    await fake.runTimers();
    expect(fake.content).toBe('');

    await copySecret('s3cret', fake.backends);
    fake.content = 'something the person copied since';
    await fake.runTimers();
    expect(fake.content).toBe('something the person copied since');
  });

  it('replaces the pending clear when a second secret is copied', async () => {
    const fake = fakeBackends(false);
    await copySecret('first', fake.backends);
    await copySecret('second', fake.backends);
    expect(fake.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    await fake.runTimers();
    expect(fake.content).toBe('');
  });

  it('copies a username or a website plainly, without clearing it', async () => {
    const fake = fakeBackends(true);
    await copyText('me@example.com', fake.backends);
    expect(fake.content).toBe('me@example.com');
    expect(fake.native.setSensitiveString).not.toHaveBeenCalled();
    expect(fake.timers).toHaveLength(0);
  });
});
