import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Lock, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useDeleteFixedAsset, useFixedAsset } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { AssetStatus, FixedAssetBookWithSchedule, FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { trimNumber } from '../asset-form-model';
import { fill, errorMessage } from '../text';
import { IssueList } from '../components/issue-list';
import { DisposeDialog } from '../components/dispose-dialog';
import { AnnualScheduleTable, LedgerPostingsTable } from '../components/schedule-table';

const STATUS_VARIANT: Record<AssetStatus, 'success' | 'secondary' | 'outline'> = {
  active: 'success',
  fully_depreciated: 'secondary',
  disposed: 'outline',
};

function Fact({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function BookPanel({ book, asset }: Readonly<{ book: FixedAssetBookWithSchedule; asset: FixedAssetDetail }>) {
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const tb = fa.detail.book;
  const { formatMoney } = useWeldbooksFormat();
  const schedule = book.schedule;
  const ledgerRows = book.postsToLedger ? asset.ledgerRows.filter((row) => row.bookId === book.id) : [];

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Fact label={tb.method}>{fa.methods[schedule.method]}</Fact>
        <Fact label={tb.convention}>{fa.conventions[schedule.convention]}</Fact>
        <Fact label={tb.recoveryYears}>{fill(tb.years, { years: trimNumber(schedule.recoveryYears) })}</Fact>
        <Fact label={tb.depreciableBasis}>{formatMoney(schedule.basis.depreciableBasis)}</Fact>
        {schedule.basis.section179 > 0 ? <Fact label={tb.section179}>{formatMoney(schedule.basis.section179)}</Fact> : null}
        {schedule.basis.bonus > 0 ? (
          <Fact label={tb.bonus}>
            {formatMoney(schedule.basis.bonus)} ({trimNumber(book.bonusPercent)}%)
          </Fact>
        ) : null}
        <Fact label={tb.totalDeducted}>{formatMoney(schedule.basis.totalDepreciable)}</Fact>
      </dl>
      <p className="text-xs text-muted-foreground">{book.postsToLedger ? tb.postsToLedger : tb.taxOnly}</p>

      {schedule.annual.length === 0 ? (
        <p className="text-sm text-muted-foreground">{fa.detail.noSchedule}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium">{fa.detail.annual.title}</p>
          <AnnualScheduleTable rows={schedule.annual} />
        </div>
      )}

      {book.postsToLedger ? <LedgerPostingsTable rows={ledgerRows} /> : null}
    </div>
  );
}

/** One fixed asset: what it cost, what is posted, and the depreciation schedule of every book. */
export default function FixedAssetDetailPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const td = fa.detail;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { data: asset, isLoading, isError, refetch } = useFixedAsset(id);
  const accountsQuery = useAccountingAccounts();
  const deleteAsset = useDeleteFixedAsset();
  const [disposing, setDisposing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (isError) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-destructive" role="alert">
          {td.loadFailed}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {common.retry}
        </Button>
      </div>
    );
  }
  if (!asset) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-muted-foreground">{td.notFound}</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/weldbooks/fixed-assets">{td.back}</Link>
        </Button>
      </div>
    );
  }

  const accountName = (accountId: string): string => {
    const account = accountsQuery.data?.data.find((item) => item.id === accountId);
    return account ? `${account.code} — ${account.name}` : accountId;
  };

  const disposed = asset.status === 'disposed';
  const hasPosted = asset.ledgerRows.some((row) => row.journalEntryId !== null);
  const locked = disposed || hasPosted;
  const ledgerBook = asset.books.find((book) => book.postsToLedger);
  const defaultTab = ledgerBook?.id ?? asset.books[0]?.id;
  const bookLabel = (book: FixedAssetBookWithSchedule) =>
    book.book === 'state' && book.stateCode ? `${fa.bookKinds.state} ${book.stateCode}` : fa.bookKinds[book.book];
  const businessUse = Number(asset.businessUsePercent);

  const confirmRemoval = async () => {
    try {
      await deleteAsset.mutateAsync(asset.id);
      toast.success(td.deleted);
      setConfirmDelete(false);
      void navigate({ to: '/weldbooks/fixed-assets' });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" asChild aria-label={td.back}>
            <Link to="/weldbooks/fixed-assets">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{asset.name}</h1>
              <Badge variant={STATUS_VARIANT[asset.status] ?? 'outline'}>{fa.statuses[asset.status] ?? asset.status}</Badge>
            </div>
            {asset.assetNumber ? <p className="text-sm text-muted-foreground">{fill(td.number, { number: asset.assetNumber })}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can('accounts:update') ? (
            <Button variant="outline" asChild>
              <Link to="/weldbooks/fixed-assets/$id/edit" params={{ id: asset.id }}>
                <Pencil className="h-4 w-4" />
                {td.edit}
              </Link>
            </Button>
          ) : null}
          {!disposed && can('accounts:update') && can('journal:create') ? (
            <Button variant="outline" onClick={() => setDisposing(true)} data-testid="dispose-open">
              {td.dispose}
            </Button>
          ) : null}
          {!disposed && can('accounts:delete') ? (
            <Button variant="outline" onClick={() => setConfirmDelete(true)} disabled={hasPosted} title={hasPosted ? td.deleteBlocked : undefined}>
              <Trash2 className="h-4 w-4" />
              {td.delete}
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          [td.summary.cost, formatMoney(asset.cost)],
          [td.summary.accumulated, formatMoney(asset.accumulatedPosted)],
          [td.summary.netBookValue, formatMoney(asset.netBookValuePosted)],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="py-4">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{value}</dd>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="py-4">
            <dt className="text-xs text-muted-foreground">{td.summary.status}</dt>
            <dd className="text-xl font-semibold">{fa.statuses[asset.status] ?? asset.status}</dd>
          </CardContent>
        </Card>
      </dl>

      {locked && !disposed ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="asset-locked">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {td.locked}
        </p>
      ) : null}

      <IssueList issues={asset.issues} title={td.issuesTitle} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.facts.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4">
              <Fact label={td.facts.acquisitionDate}>{formatDate(asset.acquisitionDate)}</Fact>
              <Fact label={td.facts.placedInServiceDate}>{formatDate(asset.placedInServiceDate)}</Fact>
              {asset.assetClass ? (
                <Fact label={td.facts.class}>{(fa.classes as Record<string, string>)[asset.assetClass] ?? asset.assetClass}</Fact>
              ) : null}
              {Number(asset.salvageValue) > 0 ? <Fact label={td.facts.salvageValue}>{formatMoney(asset.salvageValue)}</Fact> : null}
              {businessUse !== 100 ? <Fact label={td.facts.businessUse}>{trimNumber(asset.businessUsePercent)}%</Fact> : null}
              <Fact label={td.facts.assetAccount}>{accountName(asset.assetAccountId)}</Fact>
              <Fact label={td.facts.accumulatedAccount}>{accountName(asset.accumulatedDepreciationAccountId)}</Fact>
              <Fact label={td.facts.expenseAccount}>{accountName(asset.depreciationExpenseAccountId)}</Fact>
              {asset.billId ? (
                <Fact label={td.facts.bill}>
                  <Link to="/weldbooks/bills/$id" params={{ id: asset.billId }} className="underline-offset-2 hover:underline">
                    {td.facts.viewBill}
                  </Link>
                </Fact>
              ) : null}
              {asset.description ? (
                <div className="col-span-2">
                  <Fact label={td.facts.description}>{asset.description}</Fact>
                </div>
              ) : null}
              {asset.notes ? (
                <div className="col-span-2">
                  <Fact label={td.facts.notes}>
                    <span className="whitespace-pre-wrap">{asset.notes}</span>
                  </Fact>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        {disposed ? (
          <Card data-testid="disposal-card">
            <CardHeader>
              <CardTitle className="text-base">{td.disposal.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <Fact label={td.disposal.date}>{formatDate(asset.disposalDate)}</Fact>
                <Fact label={td.disposal.proceeds}>{formatMoney(asset.disposalProceeds ?? 0)}</Fact>
                {asset.disposalJournalEntryId ? (
                  <Fact label={td.disposal.entry}>
                    <Link to="/weldbooks/journal/$id" params={{ id: asset.disposalJournalEntryId }} className="underline-offset-2 hover:underline">
                      {td.disposal.viewEntry}
                    </Link>
                  </Fact>
                ) : null}
              </dl>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">{td.booksTitle}</h2>
        {asset.books.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td.noSchedule}</p>
        ) : (
          <Tabs defaultValue={defaultTab}>
            <TabsList className="h-auto flex-wrap justify-start">
              {asset.books.map((book) => (
                <TabsTrigger key={book.id} value={book.id}>
                  {bookLabel(book)}
                </TabsTrigger>
              ))}
            </TabsList>
            {asset.books.map((book) => (
              <TabsContent key={book.id} value={book.id} className="pt-4">
                <BookPanel book={book} asset={asset} />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>

      {disposing ? <DisposeDialog asset={asset} open onOpenChange={(open) => setDisposing(open)} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={fill(td.deleteTitle, { name: asset.name })}
        description={td.deleteBody}
        confirmLabel={td.deleteConfirm}
        cancelLabel={common.cancel}
        variant="destructive"
        onConfirm={confirmRemoval}
      />
    </div>
  );
}
