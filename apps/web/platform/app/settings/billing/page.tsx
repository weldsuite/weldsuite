
import { useEffect, useState, useMemo } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Progress } from '@weldsuite/ui/components/progress';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Download, Plus, Star } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { usePermissions } from '@weldsuite/permissions/react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { BillingSubscriptionResponse, BillingInvoiceResponse } from '@/lib/api/domains/billing';
import type { PhoneSubscriptionResponse } from '@/lib/api/billing-worker-client';
import type { VoipPhoneNumber } from '@/lib/api/domains/call-intelligence';
import type { HostDomain } from '@/lib/api/domains/weldhost';
import { useSubscription, useInvoices, usePlanLimits, usePhoneSubscription, useCancelSubscription, useReactivateSubscription, useCreditsBalance, useCreditPackages, useBuyCredits } from '@/hooks/queries/use-billing-queries';
import { useWorkspaceSettings, useUpdateWorkspaceSettings } from '@/hooks/queries/use-settings-queries';
import { Billing } from '@/lib/api/types/apps/billing.types';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface WorkspaceBusinessSettings {
  email?: string;
  legalName?: string;
  name?: string;
  addressLine1?: string;
  addressLine2?: string;
  country?: string;
  city?: string;
  postalCode?: string;
  state?: string;
  vatNumber?: string;
}

interface WorkspaceSettingsData extends WorkspaceBusinessSettings {
  settings?: {
    business?: WorkspaceBusinessSettings;
  };
}

function PhoneNumbersTable({
  phoneNumbers,
  phoneSubscription,
  formatCurrency,
}: {
  phoneNumbers: VoipPhoneNumber[];
  phoneSubscription: PhoneSubscriptionResponse | null;
  formatCurrency: (amount: number, currency?: string) => string;
}) {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.billing;
  const columns: ColumnDef<VoipPhoneNumber>[] = useMemo(() => [
    {
      accessorKey: 'phoneNumber',
      header: ts.number,
      size: 250,
      cell: ({ row }) => {
        const phone = row.original;
        return (
          <div className="flex items-center gap-2">
            <span className="font-mono font-medium">
              {phone.formattedNumber || phone.phoneNumber}
            </span>
            {phone.isDefault && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{st('sweep.settings.billingPage.defaultPhoneNumber')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'displayName',
      header: ts.name,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.displayName || '—'}
        </span>
      ),
    },
    {
      id: 'type',
      header: ts.type,
      cell: ({ row }) => (
        <Badge variant="secondary" className="font-mono text-xs rounded-md border border-border capitalize">
          {row.original.numberType || 'local'}
        </Badge>
      ),
    },
    {
      accessorKey: 'countryCode',
      header: ts.country,
      cell: ({ row }) => (
        <Badge variant="secondary" className="font-mono text-xs rounded-md border border-border">
          {row.original.countryCode}
        </Badge>
      ),
    },
  ], [ts, st]);

  const table = useReactTable({
    data: phoneNumbers,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="text-[13.5px]" style={{ width: header.getSize() }}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            <>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="h-[42px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {phoneSubscription?.exists && phoneSubscription.totalMonthly != null && (
                <TableRow>
                  <TableCell className="h-[42px] py-0 px-3 bg-muted/30 font-medium text-sm" colSpan={3}>
                    {ts.monthlyTotal}
                  </TableCell>
                  <TableCell className="h-[42px] py-0 px-3 bg-muted/30 font-medium text-sm">
                    {formatCurrency(phoneSubscription.totalMonthly)}{ts.perMonth}
                  </TableCell>
                </TableRow>
              )}
            </>
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {ts.noPhoneNumbers}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function DomainsTable({ domains }: { domains: HostDomain[] }) {
  const { t } = useI18n();
  const ts = t.settings.billing;
  const columns: ColumnDef<HostDomain>[] = useMemo(() => [
    {
      accessorKey: 'fullDomain',
      header: ts.domain,
      size: 250,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.fullDomain}</span>
      ),
    },
    {
      id: 'expires',
      header: ts.expires,
      cell: ({ row }) => {
        const domain = row.original;
        return (
          <span className="text-sm text-muted-foreground">
            {domain.expiresAt
              ? format(new Date(domain.expiresAt), 'MMM d, yyyy')
              : '—'}
          </span>
        );
      },
    },
    {
      id: 'autoRenew',
      header: ts.autoRenew,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.autoRenew ? ts.yes : ts.no}
        </span>
      ),
    },
    {
      id: 'status',
      header: t.common.labels.status,
      cell: ({ row }) => {
        const domain = row.original;
        const isExpiringSoon = domain.expiresAt && new Date(domain.expiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        return (
          <div className="flex items-center gap-1.5">
            {isExpiringSoon && domain.status !== 'expired' && (
              <Badge variant="outline" className="rounded-sm text-xs bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-400 dark:border-yellow-800">
                {ts.expiringDoon}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={`rounded-sm text-xs capitalize ${
                domain.status === 'active'
                  ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800'
                  : domain.status === 'expired'
                  ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800'
                  : ''
              }`}
            >
              {domain.status}
            </Badge>
          </div>
        );
      },
    },
  ], [ts, t]);

  const table = useReactTable({
    data: domains,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="text-[13.5px]" style={{ width: header.getSize() }}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="h-[42px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {ts.noDomains}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default function BillingSettingsPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.billing;
  const router = useRouter();
  const { can } = usePermissions();
  const canReadBilling = can('billing:read');
  const canManageBilling = can('billing:manage');

  // React Query hooks
  const { data: subData, isLoading: subLoading } = useSubscription();
  const { data: invoicesData, isLoading: invoicesLoading } = useInvoices(10);
  const { data: limitsData, isLoading: limitsLoading } = usePlanLimits();
  const { data: phoneSubData } = usePhoneSubscription();
  const { data: settingsData } = useWorkspaceSettings();
  const { data: creditsBalanceData } = useCreditsBalance();
  const { data: creditPackagesData } = useCreditPackages();
  const cancelMutation = useCancelSubscription();
  const reactivateMutation = useReactivateSubscription();
  const buyCreditsMutation = useBuyCredits();
  const updateWorkspaceMutation = useUpdateWorkspaceSettings();

  const creditsWallet = (creditsBalanceData?.data as { currentBalance?: number; isLow?: boolean } | undefined) ?? null;
  const creditPackages = (creditPackagesData?.data as Array<{
    id: string;
    name: string;
    description?: string | null;
    credits: number;
    price: number;
    currency: string;
    isPopular?: boolean;
  }> | undefined) ?? [];
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);

  // useSubscription() hands back the subscription itself, not an envelope.
  const subscription = (subData as BillingSubscriptionResponse) ?? null;
  const invoices = (invoicesData?.data as BillingInvoiceResponse[]) ?? [];
  const planLimits = (limitsData?.data as Billing.PlanLimits) ?? null;
  const phoneSubscription = (phoneSubData?.data as PhoneSubscriptionResponse) ?? null;

  const loading = !canReadBilling ? false : (subLoading || invoicesLoading || limitsLoading);
  const { getClient } = useAppApiClient();

  // Phone numbers and domains
  const [phoneNumbers, setPhoneNumbers] = useState<VoipPhoneNumber[]>([]);
  const [domains, setDomains] = useState<HostDomain[]>([]);
  const [billingDialogOpen, setBillingDialogOpen] = useState(false);
  const [billingDetails, setBillingDetails] = useState({
    email: '',
    company: '',
    addressLine1: '',
    addressLine2: '',
    country: '',
    city: '',
    postalCode: '',
    state: '',
    vatNumber: '',
  });

  // Load phone numbers and domains
  useEffect(() => {
    if (!canReadBilling) return;
    getClient().then(async (client) => {
      try {
        const [phoneResult, domainResult] = await Promise.all([
          client.get<{ data?: VoipPhoneNumber[] }>('/billing/phone-numbers'),
          client.get<{ data?: HostDomain[] }>('/billing/domains'),
        ]);
        if (phoneResult.data) setPhoneNumbers(phoneResult.data);
        if (domainResult.data) setDomains(domainResult.data);
      } catch {
        // Best-effort load — phone numbers/domains are supplementary billing info.
      }
    });
  }, [canReadBilling, getClient]);

  // Sync billing details from workspace settings
  useEffect(() => {
    if (settingsData?.data) {
      const data = settingsData.data as WorkspaceSettingsData;
      const ws = data.settings?.business || data;
      setBillingDetails({
        email: ws.email || '',
        company: ws.legalName || ws.name || '',
        addressLine1: ws.addressLine1 || '',
        addressLine2: ws.addressLine2 || '',
        country: ws.country || '',
        city: ws.city || '',
        postalCode: ws.postalCode || '',
        state: ws.state || '',
        vatNumber: ws.vatNumber || '',
      });
    }
  }, [settingsData]);

  // Surface the outcome of a returning Stripe credit-topup checkout, then
  // strip the query param so a refresh doesn't re-toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const credits = params.get('credits');
    if (credits === 'success') {
      toast.success(ts.creditsWallet.purchaseSuccess);
    } else if (credits === 'cancelled') {
      toast.info(ts.creditsWallet.purchaseCancelled);
    }
    if (credits) {
      params.delete('credits');
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, [ts]);

  const handleManagePlan = () => {
    router.push('/settings/plans');
  };

  const handleBuyCredits = async (packageId: string) => {
    try {
      const { url } = await buyCreditsMutation.mutateAsync(packageId);
      if (url) {
        window.location.href = url;
      } else {
        toast.error(ts.creditsWallet.purchaseFailed);
      }
    } catch {
      toast.error(ts.creditsWallet.purchaseFailed);
    }
  };

  const handleCancelSubscription = async () => {
    if (!confirm(ts.cancelConfirm)) return;
    try {
      const result = await cancelMutation.mutateAsync();
      if (result.success) {
        toast.success(ts.messages.cancelSuccess);
      } else {
        toast.error(ts.messages.cancelFailed);
      }
    } catch {
      toast.error(ts.messages.cancelFailed);
    }
  };

  const handleReactivateSubscription = async () => {
    try {
      const result = await reactivateMutation.mutateAsync();
      if (result.success) {
        toast.success(ts.messages.reactivateSuccess);
      } else {
        toast.error(ts.messages.reactivateFailed);
      }
    } catch {
      toast.error(ts.messages.reactivateFailed);
    }
  };

  const handleUpdateBillingDetails = async () => {
    try {
      await updateWorkspaceMutation.mutateAsync({
        settings: {
          business: {
            email: billingDetails.email,
            legalName: billingDetails.company,
            addressLine1: billingDetails.addressLine1,
            addressLine2: billingDetails.addressLine2,
            country: billingDetails.country,
            city: billingDetails.city,
            postalCode: billingDetails.postalCode,
            state: billingDetails.state,
            vatNumber: billingDetails.vatNumber,
          },
        },
      });
      toast.success(ts.messages.updateSuccess);
      setBillingDialogOpen(false);
    } catch {
      toast.error(ts.messages.updateFailed);
    }
  };

  const formatCurrency = (amount: number, currency: string = 'eur') => {
    return new Intl.NumberFormat('nl-NL', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!canReadBilling) {
    return (
      <AccessDeniedEmptyState
        description={st('sweep.settings.billingPage.accessDeniedDescription')}
        permission="billing:read"
        pageLabel={st('sweep.settings.billingPage.pageLabel')}
      />
    );
  }

  const renewalDate = subscription?.currentPeriodEnd
    ? format(new Date(subscription.currentPeriodEnd), 'MMMM do, yyyy')
    : st('sweep.settings.billingPage.notAvailable');

  const membersUsed = subscription?.usedSeats || planLimits?.currentUsage?.memberCount || 1;
  const membersTotal = subscription?.purchasedSeats || planLimits?.maxMembers || planLimits?.purchasedSeats;
  const membersPercentage = membersTotal ? (membersUsed / membersTotal) * 100 : 0;

  const creditsUsed = planLimits?.currentUsage?.aiCreditsUsedThisMonth || 0;
  const creditsTotal = planLimits?.currentUsage?.creditsMonthlyAllocation || planLimits?.aiCreditsPerMonth || 250;
  const creditsBalance = planLimits?.currentUsage?.creditsBalance ?? (creditsTotal - creditsUsed);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      {/* Current Plan */}
      <div>
        <h2 className="text-base font-semibold mb-1">{ts.currentPlan}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {subscription?.status === 'active' && !subscription?.cancelAtPeriodEnd
            ? ts.renews.replace('{date}', renewalDate)
            : subscription?.cancelAtPeriodEnd
            ? ts.cancels.replace('{date}', renewalDate)
            : subscription?.status || ts.accessDeniedPlans}
        </p>

        <div className="border rounded-xl p-4 flex items-center justify-between">
          <div>
            <div>
              <p className="font-medium">{subscription?.planName || planLimits?.planName || ts.free}</p>
              <div className="flex items-center gap-2 mt-1">
                {subscription && (
                  <Badge variant={subscription.status === 'active' ? 'default' : 'secondary'} className="rounded-sm text-xs">
                    {subscription.cancelAtPeriodEnd ? ts.canceling : ts.active}
                  </Badge>
                )}
                {subscription && subscription.cycle && (
                  <span className="text-xs text-muted-foreground">{subscription.cycle}</span>
                )}
              </div>
            </div>
          </div>
          {canManageBilling && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleManagePlan}>
                {ts.changePlan}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Usage */}
      <div>
        <h2 className="text-base font-semibold mb-1">{ts.usage}</h2>
        <p className="text-sm text-muted-foreground mb-4">{ts.usageDescription}</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Members / Seats */}
          <div className="border rounded-xl px-4 pt-3.5 pb-[18px] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{ts.seats}</span>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleManagePlan}>{t.settings.actions.upgrade}</Button>
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              {membersUsed} / {membersTotal ?? '\u221E'}
            </p>
            <div className="mt-auto">
              {membersTotal && <Progress value={membersPercentage} className="h-1" />}
            </div>
          </div>

          {/* Credits — prepaid wallet */}
          <div className="border rounded-xl px-4 pt-3.5 pb-[18px] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{ts.credits}</span>
              {canManageBilling && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setBuyCreditsOpen(true)}>
                  {ts.creditsWallet.topUp}
                </Button>
              )}
            </div>
            <p className="text-lg font-semibold">
              {(creditsWallet?.currentBalance ?? creditsBalance).toLocaleString()}
              <span className="text-sm font-normal text-muted-foreground ml-1">{ts.creditsWallet.creditsUnit}</span>
            </p>
            {creditsWallet?.isLow && (
              <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1">{ts.creditsWallet.lowBalance}</p>
            )}
          </div>

        </div>
      </div>

      {/* Phone Numbers */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{ts.phoneNumbersSection}</h2>
            <span className="text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[18px] h-[18px] flex items-center justify-center rounded-[5px]">{phoneNumbers.length}</span>
          </div>
          {canManageBilling && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => router.push('/settings/apps/phone-numbers')}>
                {t.settings.actions.manage}
              </Button>
              <Button variant="outline" size="sm" onClick={() => router.push('/settings/apps/phone-numbers/new-number')}>
                <Plus className="w-3.5 h-3.5 mr-0.5" />
                {ts.addNumber}
              </Button>
            </div>
          )}
        </div>

        <PhoneNumbersTable phoneNumbers={phoneNumbers} phoneSubscription={phoneSubscription} formatCurrency={formatCurrency} />
      </div>

      {/* Domains */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{ts.domainsSection}</h2>
            <span className="text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[18px] h-[18px] flex items-center justify-center rounded-[5px]">{domains.length}</span>
          </div>
          {canManageBilling && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => router.push('/weldhost/domains')}>
                {t.settings.actions.manage}
              </Button>
              <Button variant="outline" size="sm" onClick={() => router.push('/weldhost/domains/register')}>
                <Plus className="w-3.5 h-3.5 mr-0.5" />
                {ts.registerDomain}
              </Button>
            </div>
          )}
        </div>

        <DomainsTable domains={domains} />
      </div>

      {/* Billing Details */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold">{ts.billingDetails}</h2>
          {canManageBilling && (
            <Button variant="outline" size="sm" onClick={() => setBillingDialogOpen(true)}>
              {t.common.actions.edit}
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground mb-4">{ts.billingDetailsDescription}</p>

        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="h-[42px] py-0 px-3">
                  <span className="text-sm text-muted-foreground">{t.common.labels.email}</span>
                </TableCell>
                <TableCell className="h-[42px] py-0 px-3 text-right">
                  <span className="text-sm">{billingDetails.email || '\u2014'}</span>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="h-[42px] py-0 px-3">
                  <span className="text-sm text-muted-foreground">{ts.companyName}</span>
                </TableCell>
                <TableCell className="h-[42px] py-0 px-3 text-right">
                  <span className="text-sm">{billingDetails.company || '\u2014'}</span>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="h-[42px] py-0 px-3">
                  <span className="text-sm text-muted-foreground">{t.common.labels.address}</span>
                </TableCell>
                <TableCell className="h-[42px] py-0 px-3 text-right">
                  <span className="text-sm">
                    {billingDetails.addressLine1
                      ? `${billingDetails.addressLine1}${billingDetails.city ? `, ${billingDetails.city}` : ''}${billingDetails.country ? `, ${billingDetails.country}` : ''}`
                      : '\u2014'}
                  </span>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="h-[42px] py-0 px-3">
                  <span className="text-sm text-muted-foreground">{ts.vatNumber}</span>
                </TableCell>
                <TableCell className="h-[42px] py-0 px-3 text-right">
                  <span className={`text-sm ${!billingDetails.vatNumber ? 'text-muted-foreground' : ''}`}>
                    {billingDetails.vatNumber || ts.notProvided}
                  </span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      {/* History */}
      <div>
        <h2 className="text-base font-semibold mb-1">{ts.history}</h2>
        <p className="text-sm text-muted-foreground mb-4">{ts.historyDescription}</p>

        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ts.reference}</TableHead>
                <TableHead>{ts.total}</TableHead>
                <TableHead>{ts.date}</TableHead>
                <TableHead>{t.common.labels.status}</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length > 0 ? (
                invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="h-[42px] py-0 px-3">
                      <span className="font-medium text-sm">{invoice.number || invoice.id}</span>
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      <span className="text-sm">{formatCurrency(invoice.amount, invoice.currency)}</span>
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      <span className="text-sm text-muted-foreground">
                        {invoice.createdAt ? format(new Date(invoice.createdAt), 'do MMM yyyy') : '\u2014'}
                      </span>
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      <Badge
                        variant="outline"
                        className={`rounded-sm text-xs ${
                          invoice.status === 'paid'
                            ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800'
                            : ''
                        }`}
                      >
                        {invoice.status === 'paid' ? ts.paid : invoice.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="h-[42px] py-0 px-3">
                      <div className="flex justify-end">
                        {invoice.pdfUrl && (
                          <a
                            href={invoice.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Download className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    {ts.noInvoices}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Cancel / Reactivate Subscription */}
      {canManageBilling && subscription && subscription.status === 'active' && (
        <div>
          {subscription.cancelAtPeriodEnd ? (
            <Button variant="outline" onClick={handleReactivateSubscription}>
              {ts.reactivateSubscription}
            </Button>
          ) : (
            <Button variant="outline" onClick={handleCancelSubscription}>
              {ts.cancelSubscription}
            </Button>
          )}
        </div>
      )}

      {/* Update Billing Details Dialog */}
      <Dialog open={billingDialogOpen} onOpenChange={setBillingDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{ts.updateBillingDetails}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Billing Email */}
            <div className="space-y-2">
              <Label htmlFor="billing-email">
                {ts.billingEmail} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="billing-email"
                value={billingDetails.email}
                onChange={(e) => setBillingDetails({ ...billingDetails, email: e.target.value })}
                placeholder="email@example.com"
              />
            </div>

            {/* Company */}
            <div className="space-y-2">
              <Label htmlFor="company">
                {ts.companyName} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="company"
                value={billingDetails.company}
                onChange={(e) => setBillingDetails({ ...billingDetails, company: e.target.value })}
              />
            </div>

            {/* Address Line 1 */}
            <div className="space-y-2">
              <Label htmlFor="address1">
                {ts.addressLine1} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="address1"
                value={billingDetails.addressLine1}
                onChange={(e) => setBillingDetails({ ...billingDetails, addressLine1: e.target.value })}
              />
            </div>

            {/* Address Line 2 */}
            <div className="space-y-2">
              <Label htmlFor="address2">{ts.addressLine2}</Label>
              <Input
                id="address2"
                value={billingDetails.addressLine2}
                onChange={(e) => setBillingDetails({ ...billingDetails, addressLine2: e.target.value })}
              />
            </div>

            {/* Country & City */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="country">
                  {ts.country} <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={billingDetails.country}
                  onValueChange={(value) => setBillingDetails({ ...billingDetails, country: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t.settings.generalSettings.selectCountry} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NL">{st('sweep.settings.billingPage.countries.nl')}</SelectItem>
                    <SelectItem value="BE">{st('sweep.settings.billingPage.countries.be')}</SelectItem>
                    <SelectItem value="DE">{st('sweep.settings.billingPage.countries.de')}</SelectItem>
                    <SelectItem value="FR">{st('sweep.settings.billingPage.countries.fr')}</SelectItem>
                    <SelectItem value="GB">{st('sweep.settings.billingPage.countries.gb')}</SelectItem>
                    <SelectItem value="US">{st('sweep.settings.billingPage.countries.us')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">
                  {t.settings.generalSettings.city} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="city"
                  value={billingDetails.city}
                  onChange={(e) => setBillingDetails({ ...billingDetails, city: e.target.value })}
                />
              </div>
            </div>

            {/* Postal Code, State & VAT */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="postal">
                  {t.settings.generalSettings.postalCode} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="postal"
                  value={billingDetails.postalCode}
                  onChange={(e) => setBillingDetails({ ...billingDetails, postalCode: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">{ts.state}</Label>
                <Input
                  id="state"
                  value={billingDetails.state}
                  onChange={(e) => setBillingDetails({ ...billingDetails, state: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vat">{ts.vatNumber}</Label>
                <Input
                  id="vat"
                  value={billingDetails.vatNumber}
                  onChange={(e) => setBillingDetails({ ...billingDetails, vatNumber: e.target.value })}
                  placeholder="NL123456789B12"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setBillingDialogOpen(false)}>
              {t.common.actions.cancel}
            </Button>
            <Button onClick={handleUpdateBillingDetails}>
              {ts.updateBillingDetails}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Buy Credits Dialog */}
      <Dialog open={buyCreditsOpen} onOpenChange={setBuyCreditsOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{ts.creditsWallet.choosePackage}</DialogTitle>
          </DialogHeader>

          <div className="py-2">
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3 mb-4">
              <span className="text-sm text-muted-foreground">{ts.creditsWallet.currentBalance}</span>
              <span className="text-sm font-semibold">
                {(creditsWallet?.currentBalance ?? 0).toLocaleString()} {ts.creditsWallet.creditsUnit}
              </span>
            </div>

            {creditPackages.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">{ts.creditsWallet.noPackages}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {creditPackages.map((pkg) => (
                  <button
                    key={pkg.id}
                    type="button"
                    disabled={buyCreditsMutation.isPending}
                    onClick={() => handleBuyCredits(pkg.id)}
                    className="relative flex flex-col items-start rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-muted/40 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {pkg.isPopular && (
                      <Badge className="absolute top-3 right-3 rounded-sm text-[10px]">{ts.creditsWallet.popular}</Badge>
                    )}
                    <span className="text-lg font-semibold">
                      {pkg.credits.toLocaleString()}
                      <span className="text-xs font-normal text-muted-foreground ml-1">{ts.creditsWallet.creditsUnit}</span>
                    </span>
                    <span className="text-sm text-muted-foreground mt-1">
                      {formatCurrency(Math.round(pkg.price * 100), pkg.currency)}
                    </span>
                    {pkg.description && (
                      <span className="text-xs text-muted-foreground mt-2">{pkg.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {buyCreditsMutation.isPending && (
              <p className="text-xs text-muted-foreground text-center mt-4">{ts.creditsWallet.redirecting}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
