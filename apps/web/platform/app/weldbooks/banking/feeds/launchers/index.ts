import { launchPlaid } from './plaid';
import { launchRedirect } from './redirect';
import { launchStripeFc } from './stripe-fc';
import type { Launcher, LauncherKind } from './types';

const LAUNCHERS: Record<LauncherKind, Launcher> = {
  plaid_link: launchPlaid,
  stripe_fc: launchStripeFc,
  redirect: launchRedirect,
};

/** The launcher for a link session's `kind`: one small launcher per provider flow. */
export function launcherFor(kind: LauncherKind): Launcher {
  return LAUNCHERS[kind];
}

export { BankFeedLaunchError } from './types';
export type { LaunchContext, LaunchResult, Launcher, LauncherKind } from './types';
export { clearPendingLink, readPendingLink, safeReturnPath, savePendingLink } from './pending-link';
export type { PendingLink } from './pending-link';
export { resumePlaidOAuth } from './plaid';
