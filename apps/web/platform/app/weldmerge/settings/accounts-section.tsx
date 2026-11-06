import { useState } from 'react';
import { BadgeCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import {
  MERGE_PROVIDERS,
  type MergeProvider,
  type MergeProviderAccountDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import { useMyMergeAccounts } from '@/hooks/queries/use-weldmerge-queries';
import {
  useLinkMergeGitlabToken,
  useMergeAccountAuthorizeUrl,
  useUnlinkMergeAccount,
} from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { GithubUsernameForm } from '../components/github-username-form';
import { GitlabTokenDialog } from '../components/gitlab-token-dialog';
import { ProviderLogo } from '../components/provider-logo';
import { fill } from '../lib/format';

const ACCOUNTS_RETURN_PATH = '/weldmerge/settings?tab=accounts';

function AccountRow({
  account,
  onUnlink,
}: Readonly<{ account: MergeProviderAccountDto; onUnlink: (account: MergeProviderAccountDto) => void }>) {
  const { t } = useI18n();
  const ts = t.weldmerge.sync.accounts;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <Avatar className="size-7">
        {account.avatarUrl && <AvatarImage src={account.avatarUrl} alt="" />}
        <AvatarFallback className="text-[10px]">{account.login.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {account.displayName ? `${account.displayName} · ` : ''}
          {account.login}
        </p>
        {account.host && <p className="truncate text-xs text-muted-foreground">{fill(ts.selfManaged, { host: account.host })}</p>}
      </div>
      {account.verified ? (
        <SoftBadge tone="success">
          <BadgeCheck className="size-3" aria-hidden="true" />
          {ts.verified}
        </SoftBadge>
      ) : (
        <SoftBadge tone="neutral">{ts.typedOnly}</SoftBadge>
      )}
      <Button size="sm" variant="outline" onClick={() => onUnlink(account)}>
        {ts.unlink}
      </Button>
    </li>
  );
}

/**
 * The member's own accounts on the four providers. Linking through OAuth (or a
 * token for a self-managed GitLab) verifies the login and lets reviews and
 * merges be made as the member; a typed GitHub login still matches review
 * requests.
 */
export function AccountsSection() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const ts = tm.sync.accounts;
  const accounts = useMyMergeAccounts();
  const authorize = useMergeAccountAuthorizeUrl();
  const linkToken = useLinkMergeGitlabToken();
  const unlink = useUnlinkMergeAccount();
  const [starting, setStarting] = useState<MergeProvider | null>(null);
  const [gitlabDialog, setGitlabDialog] = useState(false);
  const [unlinking, setUnlinking] = useState<MergeProviderAccountDto | null>(null);

  if (accounts.isLoading) return <PageLoader fullScreen={false} />;
  if (accounts.isError) {
    return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void accounts.refetch()} />;
  }

  const linked = accounts.data?.accounts ?? [];

  const startLink = async (provider: MergeProvider) => {
    setStarting(provider);
    try {
      const { url } = await authorize.mutateAsync({ provider, returnTo: ACCOUNTS_RETURN_PATH });
      window.location.assign(url);
    } catch {
      toast.error(fill(ts.linkFailed, { provider: tm.provider[provider] }));
      setStarting(null);
    }
  };

  const confirmUnlink = async () => {
    if (!unlinking) return;
    try {
      await unlink.mutateAsync({ provider: unlinking.provider, host: unlinking.host });
      toast.success(ts.unlinked);
      setUnlinking(null);
    } catch {
      toast.error(ts.unlinkFailed);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{ts.title}</h2>
        <p className="text-sm text-muted-foreground">{ts.description}</p>
      </div>

      {MERGE_PROVIDERS.map((provider) => {
        const rows = linked.filter((account) => account.provider === provider);
        const hasVerified = rows.some((account) => account.verified);
        const busy = starting === provider;
        return (
          <SectionCard
            key={provider}
            title={
              <span className="flex items-center gap-2">
                <ProviderLogo provider={provider} />
                {tm.provider[provider]}
              </span>
            }
            action={rows.length === 0 ? <SoftBadge tone="neutral">{ts.notLinked}</SoftBadge> : undefined}
          >
            <div className="space-y-3">
              {rows.length > 0 && (
                <ul className="divide-y">
                  {rows.map((account) => (
                    <AccountRow key={account.id} account={account} onUnlink={setUnlinking} />
                  ))}
                </ul>
              )}

              {provider === 'github' && !hasVerified && (
                <div className="space-y-2">
                  <GithubUsernameForm current={accounts.data?.github ?? null} />
                  <p className="text-xs text-muted-foreground">{ts.typedHint}</p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={rows.length > 0 ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={() => void startLink(provider)}
                >
                  {busy && <Loader2 className="animate-spin" />}
                  {rows.length > 0 ? ts.relink : fill(ts.link, { provider: tm.provider[provider] })}
                </Button>
                {provider === 'gitlab' && (
                  <Button size="sm" variant="outline" onClick={() => setGitlabDialog(true)}>
                    {ts.linkSelfManaged}
                  </Button>
                )}
              </div>
            </div>
          </SectionCard>
        );
      })}

      <GitlabTokenDialog
        open={gitlabDialog}
        onOpenChange={setGitlabDialog}
        mode="account"
        onSubmit={(input) => linkToken.mutateAsync(input)}
      />
      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => !open && setUnlinking(null)}
        title={fill(ts.unlinkTitle, { provider: tm.provider[unlinking?.provider ?? 'github'] })}
        description={fill(ts.unlinkDescription, { login: unlinking?.login ?? '' })}
        confirmLabel={ts.unlink}
        variant="destructive"
        loading={unlink.isPending}
        onConfirm={confirmUnlink}
      />
    </div>
  );
}
