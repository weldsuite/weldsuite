import type { FillOutcome, PageFailure } from './actions';
import type { FillBlock } from './fill-policy';
import type { MessageKey } from './i18n';

const BLOCKED: Record<FillBlock | PageFailure, MessageKey> = {
  'no-page': 'fillNoPage',
  'unsupported-page': 'fillUnsupported',
  'insecure-page': 'fillInsecure',
  'no-item-host': 'fillHostMismatch',
  'host-mismatch': 'fillHostMismatch',
  'no-fields': 'fillNoFields',
  'page-changed': 'fillPageChanged',
  'injection-failed': 'fillFailed',
};

/** Why the extension could not act on the page. */
export function blockedMessageKey(reason: FillBlock | PageFailure): MessageKey {
  return BLOCKED[reason];
}

/** What to tell the user after pressing Fill. */
export function fillMessageKey(outcome: FillOutcome): MessageKey {
  if (!outcome.ok) {
    return outcome.reason === 'not-a-login' ? 'noPassword' : blockedMessageKey(outcome.reason);
  }
  if (outcome.username && outcome.password) return 'filledBoth';
  // Only the username went in: the page is on step one of a two-step login.
  return outcome.password ? 'filledPassword' : 'filledUsername';
}
