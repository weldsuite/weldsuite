import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPeerChimes, REJOIN_GRACE_MS } from './peer-chimes';

const sounds = { join: vi.fn(), leave: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  sounds.join.mockClear();
  sounds.leave.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPeerChimes', () => {
  it('chimes when someone new joins, once', () => {
    const chimes = createPeerChimes(['u_1'], sounds);

    chimes.joined('u_2');
    chimes.joined('u_2');
    chimes.joined('u_1');

    expect(sounds.join).toHaveBeenCalledTimes(1);
  });

  it('chimes a leave only after the grace period', () => {
    const chimes = createPeerChimes(['u_1'], sounds);

    chimes.left('u_1');
    vi.advanceTimersByTime(REJOIN_GRACE_MS - 1);
    expect(sounds.leave).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(sounds.leave).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when someone drops and is back within the grace period', () => {
    const chimes = createPeerChimes(['u_1'], sounds);

    chimes.left('u_1');
    vi.advanceTimersByTime(1_000);
    chimes.joined('u_1');
    vi.advanceTimersByTime(REJOIN_GRACE_MS * 2);

    expect(sounds.leave).not.toHaveBeenCalled();
    expect(sounds.join).not.toHaveBeenCalled();
  });

  it('chimes the join again for someone who really left and came back later', () => {
    const chimes = createPeerChimes(['u_1'], sounds);

    chimes.left('u_1');
    vi.advanceTimersByTime(REJOIN_GRACE_MS);
    chimes.joined('u_1');

    expect(sounds.leave).toHaveBeenCalledTimes(1);
    expect(sounds.join).toHaveBeenCalledTimes(1);
  });

  it('still recognises someone back from a drop after a resync left them out', () => {
    const chimes = createPeerChimes(['u_1', 'u_2'], sounds);

    chimes.left('u_2');
    chimes.resync(['u_1']);
    chimes.joined('u_2');
    vi.advanceTimersByTime(REJOIN_GRACE_MS);

    expect(sounds.leave).not.toHaveBeenCalled();
    expect(sounds.join).not.toHaveBeenCalled();
  });

  it('chimes at once for a leave it cannot match to anyone', () => {
    const chimes = createPeerChimes([], sounds);

    chimes.left(undefined);

    expect(sounds.leave).toHaveBeenCalledTimes(1);
  });

  it('drops pending leaves without a chime on dispose', () => {
    const chimes = createPeerChimes(['u_1'], sounds);

    chimes.left('u_1');
    chimes.dispose();
    vi.advanceTimersByTime(REJOIN_GRACE_MS);

    expect(sounds.leave).not.toHaveBeenCalled();
  });
});
