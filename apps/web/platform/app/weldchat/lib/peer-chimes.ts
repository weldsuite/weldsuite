/**
 * Join / leave chimes for the remote people in a call.
 *
 * When someone's connection drops, RealtimeKit takes them out of the room and
 * puts them back a moment later once their SDK has reconnected. Chiming on
 * both made a one-second blip sound like they left and came back, so a leave
 * only chimes once the person has stayed away for {@link REJOIN_GRACE_MS}.
 */

/** How long someone may be gone before their leave chimes: a reconnect brings them back sooner. */
export const REJOIN_GRACE_MS = 4_000;

export interface PeerChimeSounds {
  join: () => void;
  leave: () => void;
}

export interface PeerChimes {
  joined: (key: string | undefined) => void;
  left: (key: string | undefined) => void;
  /** The people in the call now, after the SDK rebuilt its list (our own reconnect). No chimes. */
  resync: (keys: string[]) => void;
  /** Drop pending leaves without chiming (the call view is going away). */
  dispose: () => void;
}

export function createPeerChimes(
  initialKeys: string[],
  sounds: PeerChimeSounds,
  graceMs: number = REJOIN_GRACE_MS,
): PeerChimes {
  let known = new Set(initialKeys);
  const pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    joined(key) {
      if (!key) return;
      const pending = pendingLeaves.get(key);
      if (pending) {
        // Back from a dropped connection: they never really left.
        clearTimeout(pending);
        pendingLeaves.delete(key);
        known.add(key);
        return;
      }
      if (known.has(key)) return;
      known.add(key);
      sounds.join();
    },
    left(key) {
      if (!key) {
        sounds.leave();
        return;
      }
      if (pendingLeaves.has(key)) return;
      pendingLeaves.set(
        key,
        setTimeout(() => {
          pendingLeaves.delete(key);
          known.delete(key);
          sounds.leave();
        }, graceMs),
      );
    },
    resync(keys) {
      known = new Set(keys);
    },
    dispose() {
      for (const timer of pendingLeaves.values()) clearTimeout(timer);
      pendingLeaves.clear();
    },
  };
}
