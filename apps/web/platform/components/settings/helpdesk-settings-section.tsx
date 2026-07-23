
import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Loader2,
  Mail,
  Plus,
  Trash2,
  CheckCircle,
  Globe,
  Inbox,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

export function HelpdeskSettingsSection() {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  const [localPart, setLocalPart] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('');

  // Fetch connected email addresses
  const { data: addresses, isLoading: addressesLoading } = useQuery({
    queryKey: ['helpdesk', 'email', 'addresses'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: HelpdeskEmailAddress[] }>('/helpdesk-email/addresses');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch verified domains
  const { data: domains, isLoading: domainsLoading } = useQuery({
    queryKey: ['helpdesk', 'email', 'domains'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: VerifiedDomain[] }>('/helpdesk-email/domains');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch existing mail accounts
  const { data: mailAccounts, isLoading: mailAccountsLoading } = useQuery({
    queryKey: ['helpdesk', 'email', 'mail-accounts'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: MailAccount[] }>('/helpdesk-email/mail-accounts');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Connect email mutation
  const connectMutation = useMutation({
    mutationFn: async (email: string) => {
      const client = await getClient();
      return client.post<{ data: HelpdeskEmailAddress }>('/helpdesk-email/addresses', { email });
    },
    onSuccess: () => {
      toast.success(t('sweep.settings.helpdeskEmail.connected'));
      setLocalPart('');
      setSelectedDomain('');
      queryClient.invalidateQueries({ queryKey: ['helpdesk', 'email'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  // Disconnect email mutation
  const disconnectMutation = useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<{ data: { id: string; isActive: boolean } }>(`/helpdesk-email/addresses/${id}`);
    },
    onSuccess: () => {
      toast.success(t('sweep.settings.helpdeskEmail.disconnected'));
      queryClient.invalidateQueries({ queryKey: ['helpdesk', 'email'] });
    },
    onError: () => {
      toast.error(t('sweep.settings.helpdeskEmail.disconnectFailed'));
    },
  });

  const handleConnect = () => {
    if (!localPart || !selectedDomain) {
      toast.error(t('sweep.settings.helpdeskEmail.enterAddressAndDomain'));
      return;
    }
    const email = `${localPart}@${selectedDomain}`;
    connectMutation.mutate(email);
  };

  const handleConnectExisting = (email: string) => {
    connectMutation.mutate(email);
  };

  const activeAddresses = (addresses || []).filter(a => a.isActive);
  const availableMailAccounts = (mailAccounts || []).filter(a => !a.isLinkedToHelpdesk);

  return (
    <div className="space-y-8">
      <div className="space-y-6">
        {/* Connected Addresses */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5" />
              {t('sweep.settings.helpdeskEmail.connectedAddresses')}
            </CardTitle>
            <CardDescription>
              {t('sweep.settings.helpdeskEmail.connectedAddressesDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {addressesLoading ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('sweep.settings.helpdeskEmail.loading')}</span>
              </div>
            ) : activeAddresses.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Mail className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>{t('sweep.settings.helpdeskEmail.noAddressesYet')}</p>
                <p className="text-sm">{t('sweep.settings.helpdeskEmail.addOneHint')}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {activeAddresses.map((addr) => (
                  <div
                    key={addr.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{addr.email}</span>
                      <Badge variant="default" className="text-xs">{t('sweep.settings.helpdeskEmail.active')}</Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => disconnectMutation.mutate(addr.id)}
                      disabled={disconnectMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Add Email Address */}
        <Card className="border-0 shadow-none bg-transparent">
          <CardHeader className="px-0">
            <CardTitle>{t('sweep.settings.helpdeskEmail.addAddress')}</CardTitle>
            <CardDescription>
              {t('sweep.settings.helpdeskEmail.addAddressDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Tabs defaultValue={availableMailAccounts.length > 0 ? 'existing' : 'new'}>
              <TabsList className="mb-4">
                <TabsTrigger value="existing" className="gap-1.5">
                  <Inbox className="h-3.5 w-3.5" />
                  {t('sweep.settings.helpdeskEmail.existingAccount')}
                </TabsTrigger>
                <TabsTrigger value="new" className="gap-1.5">
                  <Globe className="h-3.5 w-3.5" />
                  {t('sweep.settings.helpdeskEmail.newAddress')}
                </TabsTrigger>
              </TabsList>

              {/* Existing mail accounts tab */}
              <TabsContent value="existing" className="space-y-4">
                {mailAccountsLoading ? (
                  <div className="flex items-center justify-center gap-2 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t('sweep.settings.helpdeskEmail.loading')}</span>
                  </div>
                ) : availableMailAccounts.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">{t('sweep.settings.helpdeskEmail.noAvailableAccounts')}</p>
                    <p className="text-xs">
                      {t('sweep.settings.helpdeskEmail.noAvailableAccountsHint')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {availableMailAccounts.map((account) => (
                      <div
                        key={account.id}
                        className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium truncate">{account.email}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {account.displayName || account.name}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleConnectExisting(account.email)}
                          disabled={connectMutation.isPending}
                        >
                          {connectMutation.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            t('sweep.settings.helpdeskEmail.connect')
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* New address tab */}
              <TabsContent value="new" className="space-y-4">
                {domainsLoading ? (
                  <div className="flex items-center justify-center gap-2 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t('sweep.settings.helpdeskEmail.loading')}</span>
                  </div>
                ) : (domains || []).length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">{t('sweep.settings.helpdeskEmail.noVerifiedDomains')}</p>
                    <p className="text-xs">
                      {t('sweep.settings.helpdeskEmail.verifyDomainHintPrefix')} <strong>{t('sweep.settings.helpdeskEmail.verifyDomainHintPath')}</strong> {t('sweep.settings.helpdeskEmail.verifyDomainHintSuffix')}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2 items-end">
                      <div className="flex-1 space-y-2">
                        <Label htmlFor="local-part">{t('sweep.settings.helpdeskEmail.emailLabel')}</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            id="local-part"
                            value={localPart}
                            onChange={(e) => setLocalPart(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
                            placeholder="support"
                            className="flex-1"
                          />
                          <span className="text-muted-foreground px-1">@</span>
                          <Select value={selectedDomain} onValueChange={setSelectedDomain}>
                            <SelectTrigger className="w-[200px]">
                              <SelectValue placeholder={t('sweep.settings.helpdeskEmail.selectDomain')} />
                            </SelectTrigger>
                            <SelectContent>
                              {(domains || []).map((d) => (
                                <SelectItem key={d.id} value={d.domainName}>
                                  {d.domainName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    {localPart && selectedDomain && (
                      <p className="text-sm text-muted-foreground">
                        {t('sweep.settings.helpdeskEmail.willConnect')} <strong>{localPart}@{selectedDomain}</strong>
                      </p>
                    )}

                    <Button
                      onClick={handleConnect}
                      disabled={!localPart || !selectedDomain || connectMutation.isPending}
                    >
                      {connectMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-1" />
                          {t('sweep.settings.helpdeskEmail.connecting')}
                        </>
                      ) : (
                        <>
                          <Plus className="h-4 w-4 mr-1" />
                          {t('sweep.settings.helpdeskEmail.connectAddress')}
                        </>
                      )}
                    </Button>
                  </>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
