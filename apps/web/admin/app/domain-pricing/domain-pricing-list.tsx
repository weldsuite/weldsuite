'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Globe, Loader2, Percent, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import {
  applyDomainPricingMarkup,
  backfillDomainPricing,
  updateDomainPricingMarkup,
} from '@/actions/domain-pricing';
import { adminPricingCopy, fill } from '@/lib/i18n';
import {
  customerPriceMajor,
  markupKindOf,
  markupValueOf,
  type MarkupKind,
} from '@/lib/domain-pricing-markup';
import type { DomainPricingRow, DomainPricingStats } from '@/lib/domain-pricing-data';

function formatMoney(amount: string, currency: string): string {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2 });
  } catch {
    return `${amount} ${currency}`;
  }
}

function markupLabel(row: DomainPricingRow): string {
  if (row.markupAmount != null) return `+${(row.markupAmount / 100).toFixed(2)} ${row.currency}`;
  if (row.markupPercent != null) return `+${row.markupPercent}%`;
  return '—';
}

export function DomainPricingList({
  rows,
  stats,
}: {
  rows: DomainPricingRow[];
  stats: DomainPricingStats;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editRow, setEditRow] = useState<DomainPricingRow | null>(null);
  const [isMutating, startMutation] = useTransition();
  const copy = adminPricingCopy();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^\./, '');
    if (!q) return rows;
    return rows.filter((r) => r.tld.toLowerCase().includes(q));
  }, [rows, search]);

  function runBackfill() {
    startMutation(async () => {
      const result = await backfillDomainPricing();
      if (result.ok) {
        const { inserted, updated, fetched } = result.data;
        toast.success(
          inserted || updated
            ? fill(copy.backfillSuccess, { inserted, updated, fetched })
            : fill(copy.backfillAlreadyComplete, { fetched }),
        );
        setConfirm(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function saveMarkup(kind: MarkupKind, value: string, onlyEmpty: boolean) {
    startMutation(async () => {
      if (editRow) {
        const result = await updateDomainPricingMarkup(editRow.id, { kind, value });
        if (result.ok) {
          toast.success(copy.markupSaved);
          setEditRow(null);
          router.refresh();
        } else {
          toast.error(result.error);
        }
        return;
      }
      const result = await applyDomainPricingMarkup({ kind, value, onlyEmpty });
      if (result.ok) {
        toast.success(fill(copy.markupSavedCount, { count: result.data.updated }));
        setBulkOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Globe className="h-6 w-6 text-primary" />
              {copy.title}
            </span>
          }
          description={copy.description}
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkOpen(true)}
                disabled={isMutating || rows.length === 0}
              >
                <Percent className="h-4 w-4" />
                {copy.setMarginButton}
              </Button>
              <Button size="sm" onClick={() => setConfirm(true)} disabled={isMutating}>
                {isMutating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {copy.backfillButton}
              </Button>
            </>
          }
        />

        <div className="grid grid-cols-3 gap-3">
          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">{copy.catalog}</p>
              <p className="mt-1 text-lg font-medium tabular-nums">{stats.total}</p>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">{copy.active}</p>
              <p className="mt-1 text-lg font-medium tabular-nums">{stats.active}</p>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">{copy.popular}</p>
              <p className="mt-1 text-lg font-medium tabular-nums">{stats.popular}</p>
            </CardContent>
          </Card>
        </div>

        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="domain-pricing-tld-filter"
            aria-label={copy.filterTldLabel}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={copy.filterTld}
            className="pl-9"
          />
        </div>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_tr]:border-border/70">
              <TableRow>
                <TableHead className="text-[13.5px]">{copy.columnTld}</TableHead>
                <TableHead className="text-right text-[13.5px]">{copy.columnRegister}</TableHead>
                <TableHead className="text-right text-[13.5px]">{copy.columnCustomer}</TableHead>
                <TableHead className="text-right text-[13.5px]">{copy.columnRenew}</TableHead>
                <TableHead className="text-right text-[13.5px]">{copy.columnTransfer}</TableHead>
                <TableHead className="text-[13.5px]">{copy.columnMarkup}</TableHead>
                <TableHead className="text-[13.5px]">{copy.columnStatus}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr]:border-border/70">
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    {rows.length === 0 ? copy.emptyCatalog : copy.emptyFilter}
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((row) => {
                const customer = customerPriceMajor(row.registrationPrice, row);
                return (
                  <TableRow key={row.id} className="h-10 hover:bg-muted/50">
                    <TableCell className="py-2 font-mono text-sm">
                      .{row.tld.replace(/^\./, '')}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatMoney(row.registrationPrice, row.currency)}
                    </TableCell>
                    <TableCell className="py-2 text-right font-medium tabular-nums">
                      {formatMoney(customer ?? row.registrationPrice, row.currency)}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatMoney(row.renewalPrice, row.currency)}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatMoney(row.transferPrice, row.currency)}
                    </TableCell>
                    <TableCell className="py-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="tabular-nums"
                        aria-label={fill(copy.markupEditAria, { tld: row.tld.replace(/^\./, '') })}
                        onClick={() => setEditRow(row)}
                        disabled={isMutating}
                      >
                        {markupLabel(row)}
                      </Button>
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {row.isActive ? (
                          <Badge variant="secondary">{copy.statusActive}</Badge>
                        ) : (
                          <Badge variant="outline">{copy.statusInactive}</Badge>
                        )}
                        {row.isPopular && <Badge variant="outline">{copy.statusPopular}</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </PageBody>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.confirmTitle}</DialogTitle>
            <DialogDescription>{copy.confirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={isMutating}>
              {copy.confirmCancel}
            </Button>
            <Button onClick={runBackfill} disabled={isMutating}>
              {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
              {copy.confirmFetch}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MarkupDialog
        open={bulkOpen || editRow !== null}
        tld={editRow ? editRow.tld.replace(/^\./, '') : null}
        currency={editRow?.currency ?? rows[0]?.currency ?? 'USD'}
        initialKind={editRow ? markupKindOf(editRow) : 'percent'}
        initialValue={editRow ? markupValueOf(editRow) : ''}
        showScope={!editRow}
        isMutating={isMutating}
        onClose={() => {
          setBulkOpen(false);
          setEditRow(null);
        }}
        onSave={saveMarkup}
      />
    </PageContent>
  );
}

function MarkupDialog({
  open,
  tld,
  currency,
  initialKind,
  initialValue,
  showScope,
  isMutating,
  onClose,
  onSave,
}: {
  open: boolean;
  tld: string | null;
  currency: string;
  initialKind: MarkupKind;
  initialValue: string;
  showScope: boolean;
  isMutating: boolean;
  onClose: () => void;
  onSave: (kind: MarkupKind, value: string, onlyEmpty: boolean) => void;
}) {
  const copy = adminPricingCopy();
  const [kind, setKind] = useState<MarkupKind>(initialKind);
  const [value, setValue] = useState(initialValue);
  const [onlyEmpty, setOnlyEmpty] = useState(true);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setValue(initialValue);
    setOnlyEmpty(true);
  }, [open, tld, initialKind, initialValue]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {tld ? fill(copy.markupDialogTitleTld, { tld }) : copy.markupDialogTitle}
          </DialogTitle>
          <DialogDescription>{copy.markupDialogDescription}</DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={kind}
          onValueChange={(next) => setKind(next as MarkupKind)}
          className="gap-2"
        >
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="percent" id="markup-kind-percent" />
            {copy.markupKindPercent}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="amount" id="markup-kind-amount" />
            {copy.markupKindAmount}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="none" id="markup-kind-none" />
            {copy.markupKindNone}
          </label>
        </RadioGroup>

        {kind !== 'none' && (
          <div className="space-y-2">
            <Label htmlFor="markup-value">
              {kind === 'percent'
                ? copy.markupPercentLabel
                : fill(copy.markupAmountLabel, { currency })}
            </Label>
            <Input
              id="markup-value"
              type="number"
              min="0"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === 'percent' ? '20' : '2.00'}
            />
          </div>
        )}

        {showScope && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={onlyEmpty}
              onCheckedChange={(checked) => setOnlyEmpty(checked === true)}
              className="mt-0.5"
            />
            <span>{copy.markupScopeEmpty}</span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isMutating}>
            {copy.confirmCancel}
          </Button>
          <Button onClick={() => onSave(kind, value, onlyEmpty)} disabled={isMutating}>
            {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
            {copy.markupSave}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
