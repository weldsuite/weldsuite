import { useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';
import { toast } from 'sonner';
import { Loader2, MailX, RefreshCw, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { MailSubscription } from '@weldsuite/app-api-client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { interpolate, useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import {
  useMailAccounts,
  useMailSubscriptions,
  useScanMailSubscriptions,
  useUnsubscribeMailSubscription,
} from '@/hooks/queries/use-mail-queries';

type StatusFilter = 'active' | 'unsubscribed';

function senderLabel(sub: MailSubscription): string {
  return sub.senderName || sub.senderEmail;
}

/** Only a plain https link, so the browser has to open the sender's page. */
function isLinkOnly(sub: MailSubscription): boolean {
  return !!sub.unsubscribeUrl && !sub.oneClick && !sub.unsubscribeMailto;
}

type SubscriptionsStrings = ReturnType<typeof useI18n>['t']['mail']['subscriptions'];

function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function confirmDescriptionFor(ts: SubscriptionsStrings, sub: MailSubscription): string {
  let template = ts.confirmLink;
  if (sub.oneClick && sub.unsubscribeUrl) template = ts.confirmOneClick;
  else if (sub.unsubscribeMailto) template = ts.confirmMailto;
  return interpolate(template, { sender: senderLabel(sub) });
}

function notifyUnsubscribed(
  ts: SubscriptionsStrings,
  sub: MailSubscription,
  result: { method: string; url?: string | null },
): void {
  const sender = senderLabel(sub);
  const { method, url } = result;
  if (method === 'one_click') {
    toast.success(interpolate(ts.successOneClick, { sender }));
  } else if (method === 'mailto') {
    toast.success(interpolate(ts.successMailto, { sender }));
  } else if (!isLinkOnly(sub) && url) {
    // One-click failed and there was no mailto: fall back to the page.
    toast.info(interpolate(ts.successLink, { sender }), {
      action: { label: ts.openPage, onClick: () => openInNewTab(url) },
      duration: 15_000,
    });
  } else {
    toast.info(interpolate(ts.successLink, { sender }));
  }
}

function EmptyState({
  query,
  status,
  scanning,
  onScan,
}: {
  query: string;
  status: StatusFilter;
  scanning: boolean;
  onScan: () => void;
}) {
  const { t } = useI18n();
  const ts = t.mail.subscriptions;
  let message = ts.emptyUnsubscribed;
  if (query) message = ts.noResults;
  else if (status === 'active') message = ts.empty;
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-16 text-center">
      <MailX className="text-muted-foreground mb-3 size-8" />
      <p className="font-medium">{message}</p>
      {!query && status === 'active' && (
        <>
          <p className="text-muted-foreground mt-1 max-w-sm text-sm">{ts.emptyDescription}</p>
          <Button className="mt-4" onClick={onScan} disabled={scanning}>
            {scanning ? ts.scanning : ts.scan}
          </Button>
        </>
      )}
    </div>
  );
}

function SubscriptionAction({
  sub,
  stillSending,
  busy,
  onUnsubscribe,
}: {
  sub: MailSubscription;
  stillSending: boolean;
  busy: boolean;
  onUnsubscribe: (sub: MailSubscription) => void;
}) {
  const { t } = useI18n();
  const ts = t.mail.subscriptions;
  if (sub.status === 'unsubscribed') {
    return (
      <Badge variant={stillSending ? 'destructive' : 'secondary'}>
        {stillSending ? ts.stillSending : ts.unsubscribed}
      </Badge>
    );
  }
  if (sub.unsubscribeUrl || sub.unsubscribeMailto) {
    return (
      <Button variant="outline" size="sm" onClick={() => onUnsubscribe(sub)} disabled={busy}>
        {ts.unsubscribe}
      </Button>
    );
  }
  return <span className="text-muted-foreground text-xs">{ts.noUnsubscribeOption}</span>;
}

function SubscriptionRow({
  sub,
  dateLocale,
  busy,
  onUnsubscribe,
}: {
  sub: MailSubscription;
  dateLocale: typeof nl | undefined;
  busy: boolean;
  onUnsubscribe: (sub: MailSubscription) => void;
}) {
  const { t, plural } = useI18n();
  const ts = t.mail.subscriptions;
  const sender = senderLabel(sub);
  const stillSending =
    sub.status === 'unsubscribed' &&
    !!sub.unsubscribedAt &&
    new Date(sub.lastReceivedAt) > new Date(sub.unsubscribedAt);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold uppercase">
        {sender.charAt(0)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{sender}</span>
          {sub.senderName && (
            <span className="text-muted-foreground hidden truncate text-sm sm:inline">{sub.senderEmail}</span>
          )}
        </div>
        {sub.lastSubject && <p className="text-muted-foreground truncate text-sm">{sub.lastSubject}</p>}
        <p className="text-muted-foreground text-xs">
          {plural(sub.messageCount, { one: ts.emailCountOne, other: ts.emailCount })}
          {' · '}
          {interpolate(ts.lastReceived, {
            time: formatDistanceToNow(new Date(sub.lastReceivedAt), { addSuffix: true, locale: dateLocale }),
          })}
        </p>
      </div>
      <SubscriptionAction sub={sub} stillSending={stillSending} busy={busy} onUnsubscribe={onUnsubscribe} />
    </li>
  );
}

export default function SubscriptionsPage() {
  const { t, language } = useI18n();
  const ts = t.mail.subscriptions;

  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: ts.title },
  ]);

  const { data: accountsData, isLoading: accountsLoading } = useMailAccounts();
  const accounts = accountsData?.data ?? [];
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const accountId = selectedAccountId ?? (accounts.find((a) => a.isDefault) ?? accounts[0])?.id;

  const [status, setStatus] = useState<StatusFilter>('active');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<MailSubscription | null>(null);

  const { data, isLoading } = useMailSubscriptions(accountId);
  const scan = useScanMailSubscriptions();
  const unsubscribe = useUnsubscribeMailSubscription();

  const all = useMemo(() => data?.data ?? [], [data]);
  const counts = useMemo(
    () => ({
      active: all.filter((s) => s.status === 'active').length,
      unsubscribed: all.filter((s) => s.status === 'unsubscribed').length,
    }),
    [all],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (s) =>
        s.status === status &&
        (!q ||
          s.senderEmail.includes(q) ||
          (s.senderName ?? '').toLowerCase().includes(q) ||
          (s.lastSubject ?? '').toLowerCase().includes(q)),
    );
  }, [all, status, query]);

  const dateLocale = language === 'nl' ? nl : undefined;

  const handleScan = async () => {
    if (!accountId) return;
    try {
      const res = await scan.mutateAsync(accountId);
      toast.success(
        interpolate(ts.scanComplete, {
          scanned: res.data.scanned,
          subscriptions: res.data.subscriptions,
        }),
      );
    } catch {
      toast.error(ts.scanFailed);
    }
  };

  const handleUnsubscribe = async (sub: MailSubscription) => {
    // Open synchronously inside the click so the popup blocker allows it.
    if (isLinkOnly(sub)) openInNewTab(sub.unsubscribeUrl!);
    try {
      const res = await unsubscribe.mutateAsync(sub.id);
      notifyUnsubscribed(ts, sub, res.data);
    } catch {
      toast.error(interpolate(ts.failed, { sender: senderLabel(sub) }));
    } finally {
      setPending(null);
    }
  };

  if (accountsLoading) return <PageLoader fullScreen={false} />;

  if (!accountId) {
    return (
      <div className="container max-w-4xl py-8">
        <h1 className="text-3xl font-bold">{ts.title}</h1>
        <p className="text-muted-foreground mt-6">{ts.noAccount}</p>
      </div>
    );
  }

  const confirmDescription = pending ? confirmDescriptionFor(ts, pending) : '';

  return (
    <div className="container max-w-4xl py-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">{ts.title}</h1>
          <p className="text-muted-foreground mt-2">{ts.description}</p>
        </div>
        <Button variant="outline" onClick={handleScan} disabled={scan.isPending} className="shrink-0">
          {scan.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {scan.isPending ? ts.scanning : ts.scan}
        </Button>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        {accounts.length > 1 && (
          <Select value={accountId} onValueChange={setSelectedAccountId}>
            <SelectTrigger className="sm:w-64" aria-label={ts.account}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ts.searchPlaceholder}
            className="pl-9"
          />
        </div>
        <div className="bg-muted inline-flex rounded-md p-1" role="tablist">
          {(['active', 'unsubscribed'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={status === value}
              onClick={() => setStatus(value)}
              className={cn(
                'rounded px-3 py-1 text-sm font-medium transition-colors',
                status === value ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'active' ? ts.filterActive : ts.filterUnsubscribed}
              <span className="text-muted-foreground ml-1.5 tabular-nums">{counts[value]}</span>
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <PageLoader fullScreen={false} />
      ) : visible.length === 0 ? (
        <EmptyState query={query} status={status} scanning={scan.isPending} onScan={handleScan} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {visible.map((sub) => (
            <SubscriptionRow
              key={sub.id}
              sub={sub}
              dateLocale={dateLocale}
              busy={unsubscribe.isPending && unsubscribe.variables === sub.id}
              onUnsubscribe={setPending}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? interpolate(ts.confirmTitle, { sender: senderLabel(pending) }) : ''}
        description={confirmDescription}
        confirmLabel={ts.unsubscribe}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={() => (pending ? handleUnsubscribe(pending) : undefined)}
      />
    </div>
  );
}
