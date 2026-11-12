/**
 * Changing server: leave the current one cleanly, forget what it left on the
 * device, save the new choice and restart the JS so everything boots against
 * the new server (docs/plans/mobile-server-choice.md, section 7).
 *
 * Apps register what to do on the way out:
 * - `onLeaveServer`: runs first, while still signed in (unregister the push
 *   token on the old server).
 * - `onClearServerData`: runs after sign-out (query cache, offline stores,
 *   saved workspace, anything else kept per server).
 */

import { saveServerChoice, type KeyValueStore } from './state';
import type { MobileRuntime, ServerChoice } from './types';

type LeaveTask = (runtime: MobileRuntime) => unknown;
type Cleaner = () => unknown;

const leaveTasks = new Map<string, LeaveTask>();
const cleaners = new Map<string, Cleaner>();

const TASK_TIMEOUT_MS = 5000;

/** Run `task` before signing out of a server. Returns an unregister function. */
export function onLeaveServer(name: string, task: LeaveTask): () => void {
  leaveTasks.set(name, task);
  return () => {
    if (leaveTasks.get(name) === task) leaveTasks.delete(name);
  };
}

/** Run `cleaner` after signing out of a server. Returns an unregister function. */
export function onClearServerData(name: string, cleaner: Cleaner): () => void {
  cleaners.set(name, cleaner);
  return () => {
    if (cleaners.get(name) === cleaner) cleaners.delete(name);
  };
}

/** A step that never throws and never takes longer than the timeout. */
async function settle(step: () => unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(step),
      new Promise((resolve) => {
        timer = setTimeout(resolve, TASK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Best effort: leaving a server must never get stuck on one step.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ServerSwitchDeps {
  store: KeyValueStore;
  /** The runtime being left; null when the app never booted (the error screen). */
  runtime: MobileRuntime | null;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Leave the current server, save `next` and restart the app. */
export async function performServerSwitch(next: ServerChoice, deps: ServerSwitchDeps): Promise<void> {
  const { runtime } = deps;
  // Each group runs together: the tasks are independent and each has its own timeout.
  if (runtime) await Promise.all([...leaveTasks.values()].map((task) => settle(() => task(runtime))));
  await settle(deps.signOut);
  await Promise.all([...cleaners.values()].map((cleaner) => settle(cleaner)));
  await saveServerChoice(deps.store, next);
  await deps.reload();
}

/** For tests: forget every registered task. */
export function resetServerSwitchRegistry(): void {
  leaveTasks.clear();
  cleaners.clear();
}
