/**
 * Redirect launcher (Ponto, Enable Banking): remember what is being linked,
 * then send the browser to the bank's authorization page. The bank sends it back
 * to the callback route, which reads `code` and `state` and completes the link.
 */
import { savePendingLink, stateOfAuthorizationUrl } from './pending-link';
import { BankFeedLaunchError, type Launcher } from './types';

export const launchRedirect: Launcher = async (session, context) => {
  if (!session.url) throw new BankFeedLaunchError('incomplete_session');

  let target: URL;
  try {
    target = new URL(session.url);
  } catch {
    throw new BankFeedLaunchError('incomplete_session');
  }
  // The URL comes from our own API, but the browser only ever leaves for an encrypted page.
  if (target.protocol !== 'https:') throw new BankFeedLaunchError('insecure_url');

  savePendingLink({
    provider: context.provider,
    kind: 'redirect',
    mode: context.mode,
    connectionId: context.connectionId,
    redirectUrl: context.redirectUrl,
    returnTo: context.returnTo,
    defaultBankAccountId: context.defaultBankAccountId,
    state: stateOfAuthorizationUrl(session.url),
  });
  context.navigate(target.toString());
  return { status: 'redirecting' };
};
