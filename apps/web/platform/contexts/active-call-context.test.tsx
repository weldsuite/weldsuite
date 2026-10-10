/**
 * Active call coordinator: a user is in at most one live call, and joining
 * another asks first. "Leave and join" LEAVES the live call (the call's own
 * `leave`, never an end) and only then runs the join.
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  ActiveCallProvider,
  useCallSwitchDialog,
  useCallSwitchOptional,
  useOtherActiveCall,
  useRegisterActiveCall,
  type ActiveCallKind,
  type ActiveCallRef,
} from './active-call-context';

let api: ReturnType<typeof useCallSwitchOptional>;
let dialog: ReturnType<typeof useCallSwitchDialog>;
let other: ReturnType<typeof useOtherActiveCall>;

function Probe({ except }: Readonly<{ except?: ActiveCallRef }>) {
  api = useCallSwitchOptional();
  dialog = useCallSwitchDialog();
  other = useOtherActiveCall(except);
  return null;
}

/** Stands in for a call provider: registered while mounted. */
function LiveCall({
  kind,
  id,
  label,
  leave,
}: Readonly<{ kind: ActiveCallKind; id: string; label: string; leave: () => Promise<void> }>) {
  useRegisterActiveCall(kind, { id, label, leave });
  return null;
}

/** What happened, in order. */
const log: string[] = [];

function makeLeave(name = 'leave') {
  return vi.fn(async () => {
    log.push(name);
  });
}

function setup(children: ReactNode = null, probeExcept?: ActiveCallRef) {
  const tree = (extra: ReactNode) => (
    <ActiveCallProvider>
      <Probe except={probeExcept} />
      {extra}
    </ActiveCallProvider>
  );
  const view = render(tree(children));
  return { rerender: (extra: ReactNode) => view.rerender(tree(extra)) };
}

beforeEach(() => {
  log.length = 0;
});

describe('requestSwitch · nothing is live', () => {
  it('runs proceed right away and opens no dialog', () => {
    setup();
    const proceed = vi.fn();

    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'the call with Alice' }, proceed });
    });

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(dialog?.dialog).toBeNull();
  });

  it('runs proceed synchronously, inside the click that asked', () => {
    setup();
    let ran = false;

    act(() => {
      api.requestSwitch({
        target: { kind: 'meet', label: 'a new meeting' },
        proceed: () => {
          ran = true;
        },
      });
      expect(ran).toBe(true);
    });
  });

  it('logs a failing proceed instead of throwing at the caller', () => {
    setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      act(() => {
        api.requestSwitch({
          target: { kind: 'chat', label: 'x' },
          proceed: () => {
            throw new Error('boom');
          },
        });
      }),
    ).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('requestSwitch · a call is live', () => {
  it('asks first: nothing is left or joined until the user confirms', () => {
    const leave = makeLeave();
    setup(<LiveCall kind="meet" id="mtg_1" label="the meeting &quot;Standup&quot;" leave={leave} />);
    const proceed = vi.fn();

    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'the call with Alice' }, proceed });
    });

    expect(dialog?.dialog).toEqual({
      target: { kind: 'chat', label: 'the call with Alice' },
      current: 'the meeting "Standup"',
      switching: false,
    });
    expect(leave).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('leaves the live call first, then joins, then closes the dialog', async () => {
    const leave = makeLeave('leave');
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={leave} />);
    const proceed = vi.fn(() => {
      log.push('proceed');
    });
    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });

    await act(async () => {
      await dialog?.confirm();
    });

    expect(log).toEqual(['leave', 'proceed']);
    expect(dialog?.dialog).toBeNull();
  });

  it('locks the dialog (switching) while the call is being left', async () => {
    let finishLeave: () => void = () => undefined;
    const leave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLeave = resolve;
        }),
    );
    setup(<LiveCall kind="chat" id="call_1" label="Alice" leave={leave} />);
    act(() => {
      api.requestSwitch({ target: { kind: 'meet', label: 'Standup' }, proceed: vi.fn() });
    });

    let confirming: Promise<void> | undefined;
    act(() => {
      confirming = dialog?.confirm();
    });
    expect(dialog?.dialog?.switching).toBe(true);

    await act(async () => {
      finishLeave();
      await confirming;
    });
    expect(dialog?.dialog).toBeNull();
  });

  it('ignores a second confirm: the call is left (and joined) once', async () => {
    const leave = makeLeave();
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={leave} />);
    const proceed = vi.fn();
    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });

    await act(async () => {
      await Promise.all([dialog?.confirm(), dialog?.confirm()]);
    });

    expect(leave).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('stays in the call on dismiss: onCancel runs, nothing is left or joined', () => {
    const leave = makeLeave();
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={leave} />);
    const proceed = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed, onCancel });
    });

    act(() => dialog?.dismiss());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
    expect(dialog?.dialog).toBeNull();
  });

  it('lets a newer request replace an older one, which hears it was cancelled', () => {
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />);
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    act(() => {
      api.requestSwitch({ target: { kind: 'meet', label: 'Meeting B' }, proceed: vi.fn(), onCancel: firstCancel });
    });

    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed: vi.fn(), onCancel: secondCancel });
    });

    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondCancel).not.toHaveBeenCalled();
    expect(dialog?.dialog?.target.label).toBe('Alice');
  });

  it('withdraws a waiting request quietly (no onCancel) through the returned function', () => {
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />);
    const onCancel = vi.fn();
    let withdraw: () => void = () => undefined;
    act(() => {
      withdraw = api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed: vi.fn(), onCancel });
    });

    act(() => withdraw());

    expect(dialog?.dialog).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not ask about a live call that IS the target', () => {
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />);
    const proceed = vi.fn();

    act(() => {
      api.requestSwitch({
        target: { kind: 'meet', label: 'Standup' },
        except: { kind: 'meet', id: 'mtg_1' },
        proceed,
      });
    });

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(dialog?.dialog).toBeNull();
  });

  it('leaves every live call, and names them all', async () => {
    const leaveChat = makeLeave('leave-chat');
    const leaveMeet = makeLeave('leave-meet');
    setup(
      <>
        <LiveCall kind="chat" id="call_1" label="the call with Alice" leave={leaveChat} />
        <LiveCall kind="meet" id="mtg_1" label="the meeting" leave={leaveMeet} />
      </>,
    );
    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Bob' }, proceed: vi.fn() });
    });
    expect(dialog?.dialog?.current).toBe('the call with Alice, the meeting');

    await act(async () => {
      await dialog?.confirm();
    });

    expect(leaveChat).toHaveBeenCalledTimes(1);
    expect(leaveMeet).toHaveBeenCalledTimes(1);
  });

  it('goes ahead by itself when the live call ends while the dialog is open', () => {
    const view = setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />);
    const proceed = vi.fn();
    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });
    expect(dialog?.dialog).not.toBeNull();

    view.rerender(null);

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(dialog?.dialog).toBeNull();
  });

  it('does not stay in the call when leaving it fails: onCancel runs and nothing is joined', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const leave = vi.fn(async () => {
      throw new Error('leave failed');
    });
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={leave} />);
    const proceed = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      api.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed, onCancel });
    });

    await act(async () => {
      await dialog?.confirm();
    });

    expect(proceed).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog?.dialog).toBeNull();
    error.mockRestore();
  });
});

describe('runWithSwitch', () => {
  it('resolves once proceed has finished, and passes its error on', async () => {
    setup();
    await expect(
      api.runWithSwitch({ target: { kind: 'chat', label: 'x' }, proceed: async () => undefined }),
    ).resolves.toBeUndefined();
    await expect(
      api.runWithSwitch({
        target: { kind: 'chat', label: 'x' },
        proceed: async () => {
          throw new Error('could not start');
        },
      }),
    ).rejects.toThrow('could not start');
  });

  it('waits for the dialog: resolves after the confirmed join, and on "Stay"', async () => {
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />);
    const proceed = vi.fn(async () => {
      log.push('proceed');
    });

    let confirmed: Promise<void> | undefined;
    act(() => {
      confirmed = api.runWithSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });
    await act(async () => {
      await dialog?.confirm();
    });
    await expect(confirmed).resolves.toBeUndefined();
    expect(log).toEqual(['leave', 'proceed']);

    // Joined, so the user is in the chat call now; the meeting is gone.
    let stayed: Promise<void> | undefined;
    const second = vi.fn();
    setup(<LiveCall kind="meet" id="mtg_2" label="Retro" leave={makeLeave()} />);
    act(() => {
      stayed = api.runWithSwitch({ target: { kind: 'chat', label: 'Bob' }, proceed: second });
    });
    act(() => dialog?.dismiss());
    await expect(stayed).resolves.toBeUndefined();
    expect(second).not.toHaveBeenCalled();
  });
});

describe('useOtherActiveCall', () => {
  it('is null with nothing live, and names the live call otherwise', () => {
    const view = setup();
    expect(other).toBeNull();

    view.rerender(<LiveCall kind="chat" id="call_1" label="Alice" leave={makeLeave()} />);

    expect(other).toEqual({ kind: 'chat', id: 'call_1' });
  });

  it('skips the call it was told is the target', () => {
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />, { kind: 'meet', id: 'mtg_1' });
    expect(other).toBeNull();
  });

  it('still reports a different meeting', () => {
    setup(<LiveCall kind="meet" id="mtg_1" label="Standup" leave={makeLeave()} />, { kind: 'meet', id: 'mtg_2' });
    expect(other).toEqual({ kind: 'meet', id: 'mtg_1' });
  });
});

describe('without a coordinator', () => {
  it('joins right away: there is nothing to ask about', async () => {
    let standalone: ReturnType<typeof useCallSwitchOptional> | undefined;
    function Standalone() {
      standalone = useCallSwitchOptional();
      return null;
    }
    render(<Standalone />);
    const proceed = vi.fn();

    standalone?.requestSwitch({ target: { kind: 'chat', label: 'x' }, proceed });
    await standalone?.runWithSwitch({ target: { kind: 'chat', label: 'x' }, proceed });

    expect(proceed).toHaveBeenCalledTimes(2);
  });
});
