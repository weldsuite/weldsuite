import { useState } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Loader2, Mail, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyStateIllustration } from '@/components/entity-list';

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

export function EmailSettingsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const ei = t.helpdesk.integrationSettings;

  const [localPart, setLocalPart] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('');

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
      toast.success(t.helpdesk.integrationSettings.emailConnected);
      setLocalPart('');
      setSelectedDomain('');
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
      toast.success(t.helpdesk.integrationSettings.emailDisconnected);
      queryClient.invalidateQueries({ queryKey: ['helpdesk', 'email'] });
    },
    onError: () => {
      toast.error(t.helpdesk.integrationSettings.failedToDisconnectEmail);
    },
  });

  const handleConnect = () => {
    if (!localPart || !selectedDomain) {
      toast.error(t.helpdesk.integrationSettings.pleaseEnterEmailAndDomain);
      return;
    }
    connectMutation.mutate(`${localPart}@${selectedDomain}`);
  };

  const activeAddresses = (addresses || []).filter((a) => a.isActive);
  const availableMailAccounts = (mailAccounts || []).filter((a) => !a.isLinkedToHelpdesk);
  const verifiedDomains = domains || [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-4 h-[53px] border-b border-gray-200 dark:border-border bg-white dark:bg-background flex-shrink-0">
        <h2 className="text-base font-medium text-gray-900 dark:text-foreground">{ei.emailSettingsTitle}</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-8">
        <p className="text-sm text-muted-foreground">{ei.emailSettingsDesc}</p>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{ei.emailConnectedAddresses}</h3>
            <p className="text-sm text-muted-foreground">{ei.emailConnectedAddressesDesc}</p>
          </div>

          {addressesLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.helpdesk.inbox.loading}
            </div>
          ) : activeAddresses.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <EmptyStateIllustration>
                <Mail className="h-12 w-12 text-gray-300 dark:text-muted-foreground" />
              </EmptyStateIllustration>
              <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ei.emailNoAddresses}</h3>
              <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ei.emailAddOneBelow}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeAddresses.map((addr) => (
                <div
                  key={addr.id}
                  className="flex items-center justify-between rounded-lg border px-4 py-3 group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm font-medium truncate">{addr.email}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                    onClick={() => disconnectMutation.mutate(addr.id)}
                    disabled={disconnectMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{ei.emailAddAddress}</h3>
            <p className="text-sm text-muted-foreground">{ei.emailAddAddressDesc}</p>
          </div>

          {mailAccountsLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.helpdesk.inbox.loading}
            </div>
          ) : availableMailAccounts.length > 0 ? (
            <div className="space-y-2">
              {availableMailAccounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{account.email}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {account.displayName || account.name}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => connectMutation.mutate(account.email)}
                    disabled={connectMutation.isPending}
                  >
                    {connectMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      ei.emailConnectButton
                    )}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {domainsLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.helpdesk.inbox.loading}
            </div>
          ) : verifiedDomains.length === 0 ? (
            !availableMailAccounts.length ? (
              <p className="text-sm text-muted-foreground">{ei.emailNoVerifiedDomains} {ei.emailGoToSettingsLink}</p>
            ) : null
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="local-part">{ei.emailNewAddress}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="local-part"
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
              </div>
              {localPart && selectedDomain && (
                <p className="text-sm text-muted-foreground">
                  {ei.emailWillConnect} <span className="font-medium text-foreground">{localPart}@{selectedDomain}</span>
                </p>
              )}
              <Button
                onClick={handleConnect}
                disabled={!localPart || !selectedDomain || connectMutation.isPending}
              >
                {connectMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    {ei.emailConnectingButton}
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-1" />
                    {ei.emailConnectAddress}
                  </>
                )}
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
