import { useCallback } from 'react';
import { toast } from 'sonner';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { MergeOauthConnectionProvider } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { useConnectMergeGithub } from '@/hooks/queries/use-weldmerge-queries';
import { useMergeConnectionAuthorizeUrl, useMergeGithubInstallUrl } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../lib/format';
import { weldmergeSettingsTab } from '../lib/settings-path';

export const PROVIDERS_RETURN_PATH = weldmergeSettingsTab('providers');
export const GITHUB_INSTALLED_RETURN_PATH = `${PROVIDERS_RETURN_PATH}&installed=1`;

/**
 * Starts connecting (or reconnecting) a provider: GitHub adopts the existing
 * App installation or goes to the install page; GitLab.com, Bitbucket and Azure
 * DevOps go to their OAuth consent page. The provider then returns to
 * `/weldmerge/oauth/callback` (OAuth) or the settings (GitHub).
 */
export function useProviderConnect() {
  const { t } = useI18n();
  const ts = t.weldmerge.sync.providers;
  const connectGithub = useConnectMergeGithub();
  const installUrl = useMergeGithubInstallUrl();
  const authorizeUrl = useMergeConnectionAuthorizeUrl();

  const pending = connectGithub.isPending || installUrl.isPending || authorizeUrl.isPending;

  const goInstall = useCallback(async () => {
    const { url } = await installUrl.mutateAsync(GITHUB_INSTALLED_RETURN_PATH);
    toast.message(fill(ts.redirecting, { provider: t.weldmerge.provider.github }));
    window.location.assign(url);
  }, [installUrl, ts.redirecting, t.weldmerge.provider.github]);

  const connect = useCallback(
    async (provider: MergeProvider, options: { reconnect?: boolean } = {}) => {
      const name = t.weldmerge.provider[provider];
      try {
        if (provider === 'github') {
          // Already installed for the workspace: adopt it. Otherwise (or to repair a connection) go to GitHub.
          if (!options.reconnect) {
            const result = await connectGithub.mutateAsync();
            if (result.status === 'connected') {
              toast.success(fill(ts.connected, { provider: name }));
              return;
            }
          }
          await goInstall();
          return;
        }
        const { url } = await authorizeUrl.mutateAsync({
          provider: provider as MergeOauthConnectionProvider,
          returnTo: PROVIDERS_RETURN_PATH,
        });
        toast.message(fill(ts.redirecting, { provider: name }));
        window.location.assign(url);
      } catch {
        toast.error(fill(ts.startFailed, { provider: name }));
      }
    },
    [authorizeUrl, connectGithub, goInstall, t.weldmerge.provider, ts.connected, ts.redirecting, ts.startFailed],
  );

  return { connect, pending };
}
