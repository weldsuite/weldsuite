import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Calculator, Landmark, Plus, Search } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { useDebounce } from '@/hooks/use-debounce';
import { useFixedAssetRegister, useFixedAssets } from '@/hooks/queries/use-weldbooks-assets-queries';
import { ASSET_STATUSES, MACRS_CLASSES, type AssetStatus } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from './text';

const PAGE_SIZE = 25;
const ALL = 'all';

const STATUS_VARIANT: Record<AssetStatus, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  fully_depreciated: 'secondary',
  disposed: 'outline',
};

/** The fixed asset register: every asset with what it cost, what is posted and what it is worth on the books. */
export default function FixedAssetsPage() {
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const tl = fa.list;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { code } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(code);
  const { formatMoney, formatDate, today } = useWeldbooksFormat();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(ALL);
  const [assetClass, setAssetClass] = useState(ALL);
  // Cursor pagination: the cursor of every page already visited, newest last.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const debouncedSearch = useDebounce(search.trim(), 300);

  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      status: status === ALL ? undefined : status,
      assetClass: assetClass === ALL ? undefined : assetClass,
      search: debouncedSearch || undefined,
      cursor,
    }),
    [status, assetClass, debouncedSearch, cursor],
  );
  const { data, isLoading, isError, refetch } = useFixedAssets(filters);
  const assets = data?.data ?? [];
  const filtered = status !== ALL || assetClass !== ALL || debouncedSearch !== '';

  const asOf = today();
  const register = useFixedAssetRegister({ asOf, book: 'book' });
  const totals = register.data?.totals;

  const resetPaging = () => setCursors([]);

  const openAsset = (id: string) => void navigate({ to: '/weldbooks/fixed-assets/$id', params: { id } });

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-sm text-destructive" role="alert">
            {tl.loadFailed}
          </p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {common.retry}
          </Button>
        </CardContent>
      </Card>
    );
  } else if (assets.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Landmark className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="font-medium">{filtered ? tl.emptyFiltered : tl.emptyTitle}</p>
          {!filtered ? <p className="text-sm text-muted-foreground">{tl.emptyDescription}</p> : null}
          {!filtered && can('accounts:create') ? (
            <Button asChild>
              <Link to="/weldbooks/fixed-assets/new">{tl.add}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tl.columns.number}</TableHead>
                <TableHead>{tl.columns.name}</TableHead>
                {isUs ? <TableHead>{tl.columns.class}</TableHead> : null}
                <TableHead>{tl.columns.placedInService}</TableHead>
                <TableHead className="text-right">{tl.columns.cost}</TableHead>
                <TableHead className="text-right">{tl.columns.accumulated}</TableHead>
                <TableHead className="text-right" title={tl.netBookValueHelp}>
                  {tl.columns.netBookValue}
                </TableHead>
                <TableHead>{tl.columns.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.map((asset) => (
                <TableRow
                  key={asset.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  data-testid={`asset-row-${asset.id}`}
                  onClick={() => openAsset(asset.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openAsset(asset.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">{asset.assetNumber ?? '—'}</TableCell>
                  <TableCell className="max-w-[280px] truncate font-medium">{asset.name}</TableCell>
                  {isUs ? (
                    <TableCell className="whitespace-nowrap">
                      {asset.assetClass ? ((fa.classes as Record<string, string>)[asset.assetClass] ?? asset.assetClass) : '—'}
                    </TableCell>
                  ) : null}
                  <TableCell className="whitespace-nowrap">{formatDate(asset.placedInServiceDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(asset.cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(asset.accumulatedPosted)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatMoney(asset.netBookValuePosted)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[asset.status] ?? 'outline'}>{fa.statuses[asset.status] ?? asset.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{fill(tl.count, { count: data?.pagination.totalCount ?? assets.length })}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((current) => current.slice(0, -1))}>
              {common.newer}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.pagination.hasMore || !data.pagination.cursor}
              onClick={() => {
                const next = data?.pagination.cursor;
                if (next) setCursors((current) => [...current, next]);
              }}
            >
              {common.older}
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{tl.title}</h1>
          <p className="text-sm text-muted-foreground">{tl.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isUs ? (
            <Button variant="outline" asChild>
              <Link to="/weldbooks/fixed-assets/tax-depreciation">{tl.taxReport}</Link>
            </Button>
          ) : null}
          {can('journal:create') ? (
            <Button variant="outline" asChild>
              <Link to="/weldbooks/fixed-assets/depreciation">
                <Calculator className="h-4 w-4" />
                {tl.runDepreciation}
              </Link>
            </Button>
          ) : null}
          {can('accounts:create') ? (
            <Button asChild>
              <Link to="/weldbooks/fixed-assets/new">
                <Plus className="h-4 w-4" />
                {tl.add}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {totals ? (
        <Card data-testid="register-summary">
          <CardContent className="py-4">
            <p className="text-sm font-medium">{fill(tl.summaryTitle, { date: formatDate(asOf) })}</p>
            <p className="text-xs text-muted-foreground">{tl.summaryHelp}</p>
            <dl className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">{tl.summaryAssets}</dt>
                <dd className="text-lg font-semibold tabular-nums">{register.data?.lines.filter((line) => !line.disposed).length ?? 0}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{tl.summaryCost}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatMoney(totals.cost)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{tl.summaryDepreciation}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatMoney(totals.accumulatedDepreciation)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{tl.summaryNetBookValue}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatMoney(totals.netBookValue)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full sm:w-64">
          <Label htmlFor="asset-search" className="sr-only">
            {tl.searchLabel}
          </Label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id="asset-search"
            className="pl-9"
            placeholder={tl.searchPlaceholder}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPaging();
            }}
          />
        </div>
        <div className="w-44">
          <Label htmlFor="asset-filter-status" className="text-xs text-muted-foreground">
            {tl.status}
          </Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="asset-filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tl.allStatuses}</SelectItem>
              {ASSET_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {fa.statuses[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isUs ? (
          <div className="w-56">
            <Label htmlFor="asset-filter-class" className="text-xs text-muted-foreground">
              {tl.propertyClass}
            </Label>
            <Select
              value={assetClass}
              onValueChange={(value) => {
                setAssetClass(value);
                resetPaging();
              }}
            >
              <SelectTrigger id="asset-filter-class">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{tl.allClasses}</SelectItem>
                {MACRS_CLASSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {fa.classes[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {body}
    </div>
  );
}
