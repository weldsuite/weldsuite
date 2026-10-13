import { useMemo, useState } from 'react';
import { Ellipsis, Globe, Loader2, Plus, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReachDomain } from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDisconnectReachDomain,
  useReachAccess,
  useReachDomainCandidates,
  useReachDomains,
  useRefreshReachDomainDns,
} from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { DomainCandidateList, WeldHostDomainShortcuts } from '../components/domain-candidates';
import { DnsChecks, DomainStatusBadge } from '../components/status';
import { EmptyPanel, ErrorPanel, SectionCard } from '../components/page-kit';

export function DomainsSection() {
  const t = useTranslations();
  const { can } = usePermissions();
  const domains = useReachDomains();
  const access = useReachAccess();
  const [connectOpen, setConnectOpen] = useState(false);
  const [toDisconnect, setToDisconnect] = useState<ReachDomain | null>(null);

  const refreshDns = useRefreshReachDomainDns();
  const disconnect = useDisconnectReachDomain();

  const canConnect = can('reach_mailboxes:create');
  const canRefresh = can('reach_mailboxes:update');
  const canDisconnect = can('reach_mailboxes:delete');
  const limit = access.data?.limits.maxDomains;
  const used = domains.data?.length ?? 0;
  const atLimit = limit !== undefined && used >= limit;

  const handleRefresh = async (domain: ReachDomain) => {
    try {
      await refreshDns.mutateAsync(domain.id);
      toast.success(t('reach.mailboxes.domains.refreshed'));
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  };

  const handleDisconnect = async () => {
    if (!toDisconnect) return;
    try {
      await disconnect.mutateAsync(toDisconnect.id);
      toast.success(t('reach.mailboxes.domains.disconnected'));
      setToDisconnect(null);
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
      setToDisconnect(null);
    }
  };

  const connectButton = canConnect ? (
    <Button size="sm" onClick={() => setConnectOpen(true)} disabled={atLimit}>
      <Plus className="mr-1.5 h-4 w-4" />
      {t('reach.mailboxes.domains.connect')}
    </Button>
  ) : undefined;

  return (
    <SectionCard
      title={t('reach.mailboxes.domains.title')}
      description={
        limit === undefined
          ? t('reach.mailboxes.domains.description')
          : `${t('reach.mailboxes.domains.description')} ${t('reach.mailboxes.domains.limitHint', { used, limit })}`
      }
      action={connectButton}
    >
      {domains.isPending && (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('reach.common.loading')}
        </div>
      )}
      {domains.isError && <ErrorPanel onRetry={() => void domains.refetch()} />}
      {domains.data && domains.data.length === 0 && (
        <EmptyPanel
          icon={Globe}
          title={t('reach.mailboxes.domains.empty')}
          description={t('reach.mailboxes.domains.emptyHint')}
          action={connectButton}
        />
      )}
      {domains.data && domains.data.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('reach.mailboxes.domains.columns.domain')}</TableHead>
                <TableHead>{t('reach.mailboxes.domains.columns.status')}</TableHead>
                <TableHead>{t('reach.mailboxes.domains.columns.dns')}</TableHead>
                <TableHead className="text-right">{t('reach.mailboxes.domains.columns.mailboxes')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('reach.mailboxes.domains.columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.data.map((domain) => {
                const hasMailboxes = domain.mailboxCount > 0;
                const refreshing = refreshDns.isPending && refreshDns.variables === domain.id;
                return (
                  <TableRow key={domain.id}>
                    <TableCell>
                      <p className="font-medium">{domain.name}</p>
                      {domain.lastError && (
                        <p className="max-w-xs truncate text-xs text-destructive" title={domain.lastError}>
                          {t('reach.mailboxes.domains.lastError', { error: domain.lastError })}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <DomainStatusBadge status={domain.status} />
                    </TableCell>
                    <TableCell>
                      <DnsChecks dns={domain.dnsStatus} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{domain.mailboxCount}</TableCell>
                    <TableCell>
                      {(canRefresh || canDisconnect) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.actions.openMenu')}>
                              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ellipsis className="h-4 w-4" />}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canRefresh && (
                              <DropdownMenuItem onSelect={() => void handleRefresh(domain)}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                {t('reach.mailboxes.domains.refreshDns')}
                              </DropdownMenuItem>
                            )}
                            {canDisconnect && (
                              <DropdownMenuItem
                                disabled={hasMailboxes}
                                title={hasMailboxes ? t('reach.mailboxes.domains.hasMailboxes') : undefined}
                                className="text-destructive focus:text-destructive"
                                onSelect={() => setToDisconnect(domain)}
                              >
                                <Unplug className="mr-2 h-4 w-4" />
                                {t('reach.mailboxes.domains.disconnect')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ConnectDomainDialog open={connectOpen} onOpenChange={setConnectOpen} />

      <ConfirmDialog
        open={toDisconnect !== null}
        onOpenChange={(open) => !open && setToDisconnect(null)}
        variant="destructive"
        title={t('reach.mailboxes.domains.disconnectTitle', { domain: toDisconnect?.name ?? '' })}
        description={t('reach.mailboxes.domains.disconnectDescription')}
        confirmLabel={t('reach.mailboxes.domains.disconnect')}
        cancelLabel={t('common.actions.cancel')}
        loading={disconnect.isPending}
        onConfirm={handleDisconnect}
      />
    </SectionCard>
  );
}

function ConnectDomainDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = useTranslations();
  const candidates = useReachDomainCandidates(open);
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = candidates.data ?? [];
    return term ? list.filter((candidate) => candidate.name.toLowerCase().includes(term)) : list;
  }, [candidates.data, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('reach.mailboxes.connectDialog.title')}</DialogTitle>
          <DialogDescription>{t('reach.mailboxes.connectDialog.description')}</DialogDescription>
        </DialogHeader>

        <WeldHostDomainShortcuts onRefresh={() => void candidates.refetch()} refreshing={candidates.isFetching} />

        {candidates.isPending && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('reach.common.loading')}
          </div>
        )}
        {candidates.isError && <ErrorPanel onRetry={() => void candidates.refetch()} />}
        {candidates.data && (
          <>
            {candidates.data.length > 6 && (
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('reach.mailboxes.connectDialog.search')}
                aria-label={t('reach.mailboxes.connectDialog.search')}
              />
            )}
            <DomainCandidateList
              candidates={visible}
              canConnect
              onConnected={() => onOpenChange(false)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
