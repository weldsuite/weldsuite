import { useEffect, useRef, useState } from 'react';
import { Loader2, Link2, RefreshCw, Unlink } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useSocialAccounts,
  useConnectSocialAccount,
  useDisconnectSocialAccount,
  useSyncSocialAccounts,
} from '@/hooks/queries/use-social-queries';
import type { SocialPlatform } from '@weldsuite/app-api-client/domains/social';

const platformEmoji: Record<string, string> = {
  facebook: '📘',
  instagram: '📸',
  twitter: '🐦',
  linkedin: '💼',
  tiktok: '🎵',
};

const platforms = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];

export function AccountsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<SocialPlatform | ''>('');

  const { data, isLoading } = useSocialAccounts();
  const connectAccount = useConnectSocialAccount();
  const disconnectAccount = useDisconnectSocialAccount();
  const syncAccounts = useSyncSocialAccounts();

  const accounts = data?.data || [];

  // After the user authorizes on the provider, PostPeer redirects back here with
  // `?connected=<platform>`. Import the just-connected channel and clean the URL.
  const didHandleReturn = useRef(false);
  useEffect(() => {
    if (didHandleReturn.current) return;
    const connected = new URLSearchParams(window.location.search).get('connected');
    if (!connected) return;
    didHandleReturn.current = true;
    // Drop the query param so a refresh doesn't re-run the sync.
    window.history.replaceState({}, '', '/social/accounts');
    syncAccounts
      .mutateAsync()
      .then((res) => {
        const synced = (res as any)?.data?.synced ?? 0;
        if (synced > 0) toast.success(t.social.messages.accountConnected);
        else toast.message(t.social.accounts.noAccounts);
      })
      .catch(() => toast.error(t.social.accounts.error));
    // Run once on mount; syncAccounts/t are stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async () => {
    if (!selectedPlatform) return;
    try {
      // Tell PostPeer where to send the user after OAuth so they land back in
      // the app (which then auto-syncs the new channel), instead of on
      // PostPeer's raw JSON callback page.
      const redirectUri = `${window.location.origin}/social/accounts?connected=${selectedPlatform}`;
      const res = await connectAccount.mutateAsync({
        platform: selectedPlatform as SocialPlatform,
        redirectUri,
      });
      const url = (res as any)?.data?.url;
      setConnectOpen(false);
      if (url) {
        // Full-page redirect so the provider returns the user to the app.
        window.location.href = url;
      }
    } catch {
      toast.error(t.social.accounts.connectAccount);
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      await disconnectAccount.mutateAsync(id);
      toast.success(t.social.messages.accountDisconnected);
    } catch {
      // ignore
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t.social.accounts.title}</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => syncAccounts.mutate()}
            disabled={syncAccounts.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncAccounts.isPending ? 'animate-spin' : ''}`} />
            {st('sweep.miscA.socialAccounts.syncAll')}
          </Button>
          <Button onClick={() => setConnectOpen(true)}>
            {t.social.accounts.connectAccount}
          </Button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <Link2 className="h-8 w-8 opacity-20" />
          <p className="text-sm">{t.social.accounts.noAccounts}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((account: any) => (
            <Card key={account.id}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{platformEmoji[account.platform] || '🌐'}</span>
                  <div>
                    <CardTitle className="text-base">{account.name}</CardTitle>
                    {account.username && (
                      <p className="text-xs text-muted-foreground">@{account.username}</p>
                    )}
                  </div>
                </div>
                <Badge
                  variant={account.status === 'active' ? 'default' : 'destructive'}
                  className="text-xs"
                >
                  {account.status === 'active' ? t.social.accounts.active : account.status}
                </Badge>
              </CardHeader>
              <CardContent>
                {account.lastSyncAt && (
                  <p className="text-xs text-muted-foreground mb-3">
                    {st('sweep.miscA.socialAccounts.lastSynced', { date: formatDate(new Date(account.lastSyncAt), 'MMM d, h:mm a') })}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDisconnect(account.id)}
                  disabled={disconnectAccount.isPending}
                >
                  <Unlink className="h-3.5 w-3.5 mr-1.5" />
                  {t.social.accounts.disconnectAccount}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.social.accounts.connectAccount}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t.social.accounts.selectPlatform}</Label>
              <Select value={selectedPlatform} onValueChange={(v) => setSelectedPlatform(v as SocialPlatform)}>
                <SelectTrigger>
                  <SelectValue placeholder={st('sweep.miscA.socialAccounts.selectPlatform')} />
                </SelectTrigger>
                <SelectContent>
                  {platforms.map((p) => (
                    <SelectItem key={p} value={p}>
                      {platformEmoji[p]} {t.social.accounts.platforms[p as keyof typeof t.social.accounts.platforms]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConnectOpen(false)}>
              {t.social.actions.cancel}
            </Button>
            <Button
              onClick={handleConnect}
              disabled={!selectedPlatform || connectAccount.isPending}
            >
              {t.social.accounts.connectAccount}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
