/**
 * Partner workspaces: every customer workspace the partner licenses, with the
 * price they charge and what WeldSuite bills for it this month.
 */

import { useEffect, useMemo, useState } from 'react';
import { Building2, Plus, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { ManagedWorkspaceRow } from '@weldsuite/app-api-client/schemas/partners';
import { usePartnerRequests, usePartnerWorkspaces } from '@/hooks/queries/use-partner-queries';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { Link, useRouter, useSearchParams } from '@/lib/router';
import {
  EmptyBlock,
  ErrorBlock,
  LicenceStatusBadge,
  LoadingBlock,
  PageHeader,
  errorText,
  useFormatters,
} from '../components/kit';
import { NewWorkspaceDialog, type NewWorkspacePrefill } from '../components/new-workspace-dialog';

/** `value`, but only once it has stopped changing for `delayMs`. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function usePricingLabel() {
  const { t, format } = useI18n();
  const f = useFormatters();
  return (pricing: ManagedWorkspaceRow['licence']['resalePricing']) =>
    format(pricing.model === 'flat' ? t.partner.workspaces.pricingFlat : t.partner.workspaces.pricingPerSeat, {
      amount: f.money(pricing.amount),
    });
}

export default function PartnerWorkspacesPage() {
  const { t, format } = useI18n();
  const tw = t.partner.workspaces;
  const f = useFormatters();
  const router = useRouter();
  const params = useSearchParams();
  const { can } = usePartnerContext();
  const canManage = can('partner:workspaces:manage');
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query, 300);
  const { data, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = usePartnerWorkspaces({
    q: search,
  });
  const requests = usePartnerRequests(Boolean(params.get('provision')));
  const pricingLabel = usePricingLabel();
  const [creating, setCreating] = useState(false);

  // `?provision=<requestId>` arrives from the Requests page.
  const provisionId = params.get('provision');
  const prefill = useMemo<NewWorkspacePrefill | undefined>(() => {
    if (!provisionId) return undefined;
    const request = requests.data?.find((r) => r.id === provisionId);
    if (!request) return undefined;
    return {
      requestId: request.id,
      companyName: request.companyName,
      countryCode: request.countryCode,
      ownerEmail: request.requesterEmail,
      selectedApps: request.selectedApps,
    };
  }, [provisionId, requests.data]);

  const dialogOpen = creating || Boolean(prefill);
  const closeDialog = (open: boolean) => {
    if (open) return;
    setCreating(false);
    if (provisionId) router.replace('/partner/workspaces');
  };

  const rows = data?.rows ?? [];
  const searching = search.trim() !== '';

  const newButton = canManage ? (
    <Button onClick={() => setCreating(true)}>
      <Plus className="mr-1.5 h-4 w-4" aria-hidden />
      {tw.newWorkspace}
    </Button>
  ) : undefined;

  let body;
  if (isLoading) {
    body = <LoadingBlock />;
  } else if (error) {
    body = <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />;
  } else if (rows.length === 0 && !searching) {
    body = (
      <EmptyBlock icon={Building2} title={tw.emptyTitle} description={tw.emptyDescription} action={newButton} />
    );
  } else if (rows.length === 0) {
    body = <EmptyBlock icon={Search} title={tw.noResultsTitle} description={tw.noResultsDescription} />;
  } else {
    body = (
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tw.table.name}</TableHead>
              <TableHead className="hidden md:table-cell">{tw.table.owner}</TableHead>
              <TableHead className="hidden lg:table-cell">{tw.table.package}</TableHead>
              <TableHead>{tw.table.pricing}</TableHead>
              <TableHead className="hidden sm:table-cell">{tw.table.seats}</TableHead>
              <TableHead className="hidden lg:table-cell">{tw.table.credits}</TableHead>
              <TableHead className="text-right">{tw.table.weldsuiteBills}</TableHead>
              <TableHead className="text-right">{tw.table.youKeep}</TableHead>
              <TableHead>{tw.table.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((w) => (
              <TableRow key={w.workspaceId}>
                <TableCell className="font-medium">
                  <Link href={`/partner/workspaces/${w.workspaceId}`} className="hover:underline">
                    {w.name}
                  </Link>
                  {w.provisioningStatus && w.provisioningStatus !== 'ready' && (
                    <span className="ml-2 text-xs text-muted-foreground">{tw.provisioning}</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {w.ownerEmail ?? tw.ownerPending}
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {w.packageName ?? tw.customLicence}
                </TableCell>
                <TableCell className="whitespace-nowrap">{pricingLabel(w.licence.resalePricing)}</TableCell>
                <TableCell className="hidden tabular-nums sm:table-cell">
                  {w.licence.maxSeats === null
                    ? w.activeMembers
                    : format(tw.seatsOf, { used: w.activeMembers, max: w.licence.maxSeats })}
                </TableCell>
                <TableCell className="hidden tabular-nums lg:table-cell">
                  {format(tw.creditsOf, {
                    used: f.number(w.creditsUsedThisPeriod),
                    allowance: f.number(w.licence.monthlyCredits),
                  })}
                </TableCell>
                <TableCell className="text-right tabular-nums">{f.cents(w.estimate.due)}</TableCell>
                <TableCell
                  className={`text-right tabular-nums ${w.estimate.margin < 0 ? 'text-destructive' : ''}`}
                >
                  {f.cents(w.estimate.margin)}
                </TableCell>
                <TableCell>
                  <LicenceStatusBadge status={w.licence.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <>
      <PageHeader title={tw.title} description={tw.description} actions={newButton} />
      {(rows.length > 0 || searching) && (
        <div className="relative mb-4 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            className="pl-8"
            type="search"
            placeholder={tw.searchPlaceholder}
            aria-label={tw.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {body}
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? t.partner.common.loading : tw.loadMore}
          </Button>
        </div>
      )}
      {canManage && <NewWorkspaceDialog open={dialogOpen} onOpenChange={closeDialog} prefill={prefill} />}
    </>
  );
}
