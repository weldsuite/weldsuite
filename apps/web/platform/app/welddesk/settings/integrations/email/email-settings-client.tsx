
import { useState } from 'react';
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
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
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

export function EmailSettingsClient() {
  const { t } = useI18n();
  const st = useTranslations();
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
      toast.success(t.helpdesk.integrationSettings.emailConnected);
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
    const email = `${localPart}@${selectedDomain}`;
    connectMutation.mutate(email);
  };

  const handleConnectExisting = (email: string) => {
    connectMutation.mutate(email);
  };

  const activeAddresses = (addresses || []).filter(a => a.isActive);
  const availableMailAccounts = (mailAccounts || []).filter(a => !a.isLinkedToHelpdesk);

  const ei = t.helpdesk.integrationSettings;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="container max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Mail className="h-8 w-8" />
            {ei.emailSettingsTitle}
          </h1>
          <p className="text-muted-foreground mt-1">
            {ei.emailSettingsDesc}
          </p>
        </div>

        {/* Connected Addresses */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5" />
              {ei.emailConnectedAddresses}
            </CardTitle>
            <CardDescription>
              {ei.emailConnectedAddressesDesc}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {addressesLoading ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t.helpdesk.inbox.loading}</span>
              </div>
            ) : activeAddresses.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Mail className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>{ei.emailNoAddresses}</p>
                <p className="text-sm">{ei.emailAddOneBelow}</p>
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
                      <Badge variant="default" className="text-xs">{ei.emailActiveLabel}</Badge>
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
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              {ei.emailAddAddress}
            </CardTitle>
            <CardDescription>
              {ei.emailAddAddressDesc}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={availableMailAccounts.length > 0 ? 'existing' : 'new'}>
              <TabsList className="mb-4">
                <TabsTrigger value="existing" className="gap-1.5">
                  <Inbox className="h-3.5 w-3.5" />
                  {ei.emailExistingAccount}
                </TabsTrigger>
                <TabsTrigger value="new" className="gap-1.5">
                  <Globe className="h-3.5 w-3.5" />
                  {ei.emailNewAddress}
                </TabsTrigger>
              </TabsList>

              {/* Existing mail accounts tab */}
              <TabsContent value="existing" className="space-y-4">
                {mailAccountsLoading ? (
                  <div className="flex items-center justify-center gap-2 py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t.helpdesk.inbox.loading}</span>
                  </div>
                ) : availableMailAccounts.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">{ei.emailNoMailAccounts}</p>
                    <p className="text-xs">
                      {ei.emailAllAccountsConnected}
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
                            ei.emailConnectButton
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
                  <div className="flex items-center justify-center gap-2 py-8">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{t.helpdesk.inbox.loading}</span>
                  </div>
                ) : (domains || []).length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">{ei.emailNoVerifiedDomains}</p>
                    <p className="text-xs">
                      {ei.emailGoToSettingsLink}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2 items-end">
                      <div className="flex-1 space-y-2">
                        <Label htmlFor="local-part">{ei.emailLabel}</Label>
                        <div className="flex items-center gap-1">
                          <Input
                            id="local-part"
                            value={localPart}
                            onChange={(e) => setLocalPart(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
                            placeholder={st('sweep.welddesk.emailSettings.localPartPlaceholder')}
                            className="flex-1"
                          />
                          <span className="text-muted-foreground px-1">@</span>
                          <Select value={selectedDomain} onValueChange={setSelectedDomain}>
                            <SelectTrigger className="w-[200px]">
                              <SelectValue placeholder={ei.emailSelectDomain} />
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
                        {ei.emailWillConnect} <strong>{localPart}@{selectedDomain}</strong>
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
