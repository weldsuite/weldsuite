import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { EllipsisVertical, Loader2, Mail, Plus, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
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
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { EmptyStateIllustration, FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';

interface HelpdeskEmailAddress {
  id: string;
  email: string;
  accountId: string;
  isActive: boolean;
  createdAt: string;
}

interface VerifiedDomain {
  id: string;
  domainName: string;
  dnsStatus: string;
  isActive: boolean;
}

interface MailAccount {
  id: string;
  name: string;
  email: string;
  displayName: string | null;
  provider: string;
  status: string;
  isLinkedToHelpdesk: boolean;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** An envelope with an @, for the empty list (as on WeldMail's accounts tab). */
function EmailIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="24" y="38" width="72" height="48" rx="4" className="fill-white dark:fill-secondary stroke-gray-300 dark:stroke-border" strokeWidth="1.2" />
        <path d="M24 42 L60 66 L96 42" className="stroke-gray-300 dark:stroke-border" strokeWidth="1.2" fill="none" />
        <path d="M24 86 L48 66" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" />
        <path d="M96 86 L72 66" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" />
        <circle cx="88" cy="78" r="14" className="fill-white dark:fill-secondary stroke-gray-300 dark:stroke-border" strokeWidth="1.2" />
        <text x="88" y="82" textAnchor="middle" className="fill-gray-400 dark:fill-muted-foreground" fontSize="14" fontWeight="500">
          @
        </text>
      </svg>
    </EmptyStateIllustration>
  );
}

/**
 * Settings → Apps → WeldDesk → Email: the addresses whose mail becomes
 * helpdesk conversations. Laid out like every app settings page (WeldMail's
 * accounts tab): title and description, a toolbar with Filter, search and
 * "Connect address", and a table of the connected addresses. Connecting
 * (an existing mail account, or a new address on a verified domain) is a
 * dialog.
 */
export function EmailSettingsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const ei = t.helpdesk.integrationSettings;

  const [connectOpen, setConnectOpen] = useState(false);
  const [localPart, setLocalPart] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const { data: addresses, isLoading: addressesLoading } = useQuery({
    queryKey: ['helpdesk', 'email', 'addresses'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: HelpdeskEmailAddress[] }>('/helpdesk-email/addresses');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: domains, isLoading: domainsLoading } = useQuery({
    queryKey: ['helpdesk', 'email', 'domains'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: VerifiedDomain[] }>('/helpdesk-email/domains');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: mailAccounts, isLoading: mailAccountsLoading } = useQuery({
    queryKey: ['helpdesk', 'email', 'mail-accounts'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: MailAccount[] }>('/helpdesk-email/mail-accounts');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const connectMutation = useMutation({
    mutationFn: async (email: string) => {
      const client = await getClient();
      return client.post<{ data: HelpdeskEmailAddress }>('/helpdesk-email/addresses', { email });
    },
    onSuccess: () => {
      toast.success(ei.emailConnected);
      setLocalPart('');
      setSelectedDomain('');
      setConnectOpen(false);
      queryClient.invalidateQueries({ queryKey: ['helpdesk', 'email'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ data: { id: string; isActive: boolean } }>(`/helpdesk-email/addresses/${id}`);
    },
    onSuccess: () => {
      toast.success(ei.emailDisconnected);
      queryClient.invalidateQueries({ queryKey: ['helpdesk', 'email'] });
    },
    onError: () => {
      toast.error(ei.failedToDisconnectEmail);
    },
  });

  const handleConnectNew = () => {
    if (!localPart || !selectedDomain) {
      toast.error(ei.pleaseEnterEmailAndDomain);
      return;
    }
    connectMutation.mutate(`${localPart}@${selectedDomain}`);
  };

  const activeAddresses = useMemo(() => (addresses || []).filter((a) => a.isActive), [addresses]);
  const availableMailAccounts = (mailAccounts || []).filter((a) => !a.isLinkedToHelpdesk);
  const verifiedDomains = domains || [];
  const accountName = useMemo(() => {
    const byId = new Map((mailAccounts || []).map((a) => [a.id, a.displayName || a.name]));
    return (accountId: string) => byId.get(accountId) || '—';
  }, [mailAccounts]);

  const filterConfigs: FilterConfig[] = useMemo(() => {
    const addressDomains = [...new Set(activeAddresses.map((a) => domainOf(a.email)))].sort((a, b) => a.localeCompare(b));
    return [
      {
        field: 'domain',
        label: ei.emailFilterDomain,
        filterType: 'select',
        options: addressDomains.map((domain) => ({ value: domain, label: domain })),
      },
    ];
  }, [activeAddresses, ei.emailFilterDomain]);

  if (addressesLoading) return <PageLoader fullScreen={false} />;

  const query = searchQuery.trim().toLowerCase();
  const shown = activeAddresses.filter(
    (address) =>
      (!query || address.email.toLowerCase().includes(query) || accountName(address.accountId).toLowerCase().includes(query)) &&
      activeFilters.every((filter) => {
        if (!filter.value || filter.field !== 'domain') return true;
        const matches = domainOf(address.email) === filter.value;
        return filter.operator === 'is' ? matches : !matches;
      }),
  );

  const connectButton = (
    <Button size="sm" onClick={() => setConnectOpen(true)} data-testid="desk-email-connect">
      <Plus className="h-4 w-4" />
      {ei.emailConnectAddress}
    </Button>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t.settings.welddesk.emailTitle}</h1>
        <p className="text-muted-foreground">{ei.emailSettingsDesc}</p>
      </div>

      {activeAddresses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <EmailIllustration />
          <h3 className="text-lg font-medium mb-1">{ei.emailNoAddresses}</h3>
          <p className="text-sm text-muted-foreground mb-6">{ei.emailEmptyDescription}</p>
          {connectButton}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <FilterPills
                filters={activeFilters}
                filterConfigs={filterConfigs}
                maxFilters={5}
                onFiltersChange={setActiveFilters}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={ei.emailSearchPlaceholder} />
              {connectButton}
            </div>
          </div>

          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[13.5px]">{ei.emailColAddress}</TableHead>
                  <TableHead className="text-[13.5px]">{ei.emailColAccount}</TableHead>
                  <TableHead className="w-[140px] text-[13.5px]">{ei.emailColConnected}</TableHead>
                  <TableHead className="w-[48px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length > 0 ? (
                  shown.map((address) => (
                    <TableRow key={address.id} className="group">
                      <TableCell className="h-[42px] py-0 px-3">
                        <span className="font-medium">{address.email}</span>
                      </TableCell>
                      <TableCell className="h-[42px] py-0 px-3">
                        <span className="text-sm text-muted-foreground">{accountName(address.accountId)}</span>
                      </TableCell>
                      <TableCell className="h-[42px] py-0 px-3">
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {format(new Date(address.createdAt), 'd MMM yyyy')}
                        </span>
                      </TableCell>
                      <TableCell className="h-[42px] py-0 px-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`${t.common.actions.openMenu}: ${address.email}`}
                              className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                            >
                              <EllipsisVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => disconnectMutation.mutate(address.id)}
                              disabled={disconnectMutation.isPending}
                              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                            >
                              <Unplug className="mr-0.5 h-4 w-4 text-destructive" />
                              {ei.emailDisconnect}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-sm text-muted-foreground">
                      {ei.emailNoResults}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ei.emailAddAddress}</DialogTitle>
            <DialogDescription>{ei.emailAddAddressDesc}</DialogDescription>
          </DialogHeader>

          {(mailAccountsLoading || domainsLoading) && (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.helpdesk.inbox.loading}
            </div>
          )}

          {!mailAccountsLoading && availableMailAccounts.length > 0 && (
            <div className="space-y-2">
              <Label>{ei.emailExistingAccount}</Label>
              <div className="overflow-hidden rounded-md border divide-y">
                {availableMailAccounts.map((account) => (
                  <div key={account.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <Mail className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{account.email}</p>
                        <p className="truncate text-xs text-muted-foreground">{account.displayName || account.name}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => connectMutation.mutate(account.email)}
                      disabled={connectMutation.isPending}
                    >
                      {ei.emailConnectButton}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!domainsLoading && verifiedDomains.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="desk-email-local-part">{ei.emailNewAddress}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="desk-email-local-part"
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
                  placeholder={st('sweep.welddesk.emailSettings.localPartPlaceholder')}
                  className="flex-1"
                />
                <span className="text-sm text-muted-foreground">@</span>
                <Select value={selectedDomain} onValueChange={setSelectedDomain}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder={ei.emailSelectDomain} />
                  </SelectTrigger>
                  <SelectContent>
                    {verifiedDomains.map((d) => (
                      <SelectItem key={d.id} value={d.domainName}>
                        {d.domainName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {localPart && selectedDomain && (
                <p className="text-sm text-muted-foreground">
                  {ei.emailWillConnect} <span className="font-medium text-foreground">{localPart}@{selectedDomain}</span>
                </p>
              )}
              <Button onClick={handleConnectNew} disabled={!localPart || !selectedDomain || connectMutation.isPending}>
                {connectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {connectMutation.isPending ? ei.emailConnectingButton : ei.emailConnectAddress}
              </Button>
            </div>
          )}

          {!mailAccountsLoading &&
            !domainsLoading &&
            verifiedDomains.length === 0 &&
            availableMailAccounts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {ei.emailNoVerifiedDomains} {ei.emailGoToSettingsLink}
              </p>
            )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
