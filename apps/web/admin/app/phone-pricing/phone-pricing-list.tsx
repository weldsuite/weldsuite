'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Percent, Phone, Plus, RefreshCw, Search } from 'lucide-react';
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
  applyPhonePricingMarkup,
  createPhonePricing,
  seedPhonePricing,
  updatePhonePricingMarkup,
  updatePhonePricingWholesale,
} from '@/actions/phone-pricing';
import { adminPhonePricingCopy, fill } from '@/lib/i18n';
import {
  customerPriceMajor,
  markupKindOf,
  markupValueOf,
  type MarkupKind,
} from '@/lib/domain-pricing-markup';
import type { PhonePricingDefault, PhonePricingRow } from '@/lib/phone-pricing-data';

function formatMoney(amount: string, currency: string): string {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, minimumFractionDigits: 2 });
  } catch {
    return `${amount} ${currency}`;
  }
}

function markupLabel(row: { markupAmount: number | null; markupPercent: string | null; currency?: string }): string {
  if (row.markupAmount != null) return `+${(row.markupAmount / 100).toFixed(2)} ${row.currency ?? 'USD'}`;
  if (row.markupPercent != null) return `+${row.markupPercent}%`;
  return '—';
}

export function PhonePricingList({
  rows,
  stats,
  defaultMarkup,
}: Readonly<{
  rows: PhonePricingRow[];
  stats: { total: number; active: number };
  defaultMarkup: PhonePricingDefault | null;
}>) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editRow, setEditRow] = useState<PhonePricingRow | null>(null);
  const [wholesaleRow, setWholesaleRow] = useState<PhonePricingRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [isMutating, startMutation] = useTransition();
  const copy = adminPhonePricingCopy();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.countryCode.toLowerCase().includes(q) || r.numberType.toLowerCase().includes(q),
    );
  }, [rows, search]);

  function runSeed() {
    startMutation(async () => {
      const result = await seedPhonePricing();
      if (result.ok) {
        const { inserted, updated, fetched } = result.data;
        if (!fetched) {
          toast.error(copy.seedNoSamples);
          return;
        }
        toast.success(
          inserted || updated
            ? fill(copy.seedSuccess, { inserted, updated, fetched })
            : fill(copy.seedAlreadyComplete, { fetched }),
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
        const result = await updatePhonePricingMarkup(editRow.id, { kind, value });
        if (result.ok) {
          toast.success(copy.markupSaved);
          setEditRow(null);
          router.refresh();
        } else {
          toast.error(result.error);
        }
        return;
      }
      const result = await applyPhonePricingMarkup({ kind, value, onlyEmpty });
      if (result.ok) {
        toast.success(fill(copy.markupSavedCount, { count: result.data.updated }));
        setBulkOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function saveWholesale(monthlyPrice: string) {
    if (!wholesaleRow) return;
    startMutation(async () => {
      const result = await updatePhonePricingWholesale(wholesaleRow.id, { monthlyPrice });
      if (result.ok) {
        toast.success(copy.wholesaleSaved);
        setWholesaleRow(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function runCreate(input: { countryCode: string; numberType: string; monthlyPrice: string }) {
    startMutation(async () => {
      const result = await createPhonePricing(input);
      if (result.ok) {
        toast.success(fill(copy.createSaved, { country: result.data.countryCode }));
        setCreateOpen(false);
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
              <Phone className="h-6 w-6 text-primary" />
              {copy.title}
            </span>
          }
          description={copy.description}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)} disabled={isMutating}>
                <Plus className="h-4 w-4" />
                {copy.addRowButton}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)} disabled={isMutating}>
                <Percent className="h-4 w-4" />
                {copy.setMarginButton}
              </Button>
              <Button size="sm" onClick={() => setConfirm(true)} disabled={isMutating}>
                {isMutating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {copy.seedButton}
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
              <p className="text-xs text-muted-foreground">{copy.defaultMargin}</p>
              <p className="mt-1 text-lg font-medium tabular-nums">
                {defaultMarkup ? markupLabel({ ...defaultMarkup, currency: 'USD' }) : '—'}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={copy.filterLabel}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={copy.filterPlaceholder}
            className="pl-9"
          />
        </div>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_tr]:border-border/70">
              <TableRow>
                <TableHead className="text-[13.5px]">{copy.columnCountry}</TableHead>
                <TableHead className="text-[13.5px]">{copy.columnType}</TableHead>
                <TableHead className="text-right text-[13.5px]">{copy.columnWholesale}</TableHead>
                <TableHead className="text-right text-[13.5px]">{copy.columnCustomer}</TableHead>
                <TableHead className="text-[13.5px]">{copy.columnMarkup}</TableHead>
                <TableHead className="text-[13.5px]">{copy.columnStatus}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr]:border-border/70">
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    {rows.length === 0 ? copy.emptyCatalog : copy.emptyFilter}
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((row) => {
                const customer = customerPriceMajor(row.monthlyPrice, row);
                return (
                  <TableRow key={row.id} className="h-10 hover:bg-muted/50">
                    <TableCell className="py-2 font-mono text-sm">{row.countryCode}</TableCell>
                    <TableCell className="py-2 text-sm">{row.numberType}</TableCell>
                    <TableCell className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="tabular-nums"
                        onClick={() => setWholesaleRow(row)}
                        disabled={isMutating}
                      >
                        {formatMoney(row.monthlyPrice, row.currency)}
                      </Button>
                    </TableCell>
                    <TableCell className="py-2 text-right font-medium tabular-nums">
                      {formatMoney(customer ?? row.monthlyPrice, row.currency)}
                    </TableCell>
                    <TableCell className="py-2">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="tabular-nums"
                        onClick={() => setEditRow(row)}
                        disabled={isMutating}
                      >
                        {markupLabel(row)}
                      </Button>
                    </TableCell>
                    <TableCell className="py-2">
                      {row.isActive ? (
                        <Badge variant="secondary">{copy.statusActive}</Badge>
                      ) : (
                        <Badge variant="outline">{copy.statusInactive}</Badge>
                      )}
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
            <Button onClick={runSeed} disabled={isMutating}>
              {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
              {copy.confirmFetch}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MarkupDialog
        open={bulkOpen || editRow !== null}
        label={editRow ? `${editRow.countryCode} ${editRow.numberType}` : null}
        currency={editRow?.currency ?? rows[0]?.currency ?? 'USD'}
        initialKind={editRow ? markupKindOf(editRow) : defaultMarkup ? markupKindOf(defaultMarkup) : 'percent'}
        initialValue={editRow ? markupValueOf(editRow) : defaultMarkup ? markupValueOf(defaultMarkup) : ''}
        showScope={!editRow}
        isMutating={isMutating}
        onClose={() => {
          setBulkOpen(false);
          setEditRow(null);
        }}
        onSave={saveMarkup}
      />

      <WholesaleDialog
        open={wholesaleRow !== null}
        currency={wholesaleRow?.currency ?? 'USD'}
        initialValue={wholesaleRow?.monthlyPrice ?? ''}
        markup={
          wholesaleRow
            ? { markupAmount: wholesaleRow.markupAmount, markupPercent: wholesaleRow.markupPercent }
            : { markupAmount: null, markupPercent: null }
        }
        isMutating={isMutating}
        onClose={() => setWholesaleRow(null)}
        onSave={saveWholesale}
      />

      <CreateDialog
        open={createOpen}
        isMutating={isMutating}
        onClose={() => setCreateOpen(false)}
        onSave={runCreate}
      />
    </PageContent>
  );
}

function MarkupDialog({
  open,
  label,
  currency,
  initialKind,
  initialValue,
  showScope,
  isMutating,
  onClose,
  onSave,
}: Readonly<{
  open: boolean;
  label: string | null;
  currency: string;
  initialKind: MarkupKind;
  initialValue: string;
  showScope: boolean;
  isMutating: boolean;
  onClose: () => void;
  onSave: (kind: MarkupKind, value: string, onlyEmpty: boolean) => void;
}>) {
  const copy = adminPhonePricingCopy();
  const [kind, setKind] = useState<MarkupKind>(initialKind);
  const [value, setValue] = useState(initialValue);
  const [onlyEmpty, setOnlyEmpty] = useState(true);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setValue(initialValue);
    setOnlyEmpty(true);
  }, [open, label, initialKind, initialValue]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{label ? fill(copy.markupDialogTitleRow, { row: label }) : copy.markupDialogTitle}</DialogTitle>
          <DialogDescription>{copy.markupDialogDescription}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={kind} onValueChange={(next) => setKind(next as MarkupKind)} className="gap-2">
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="percent" id="phone-markup-kind-percent" />
            {copy.markupKindPercent}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="amount" id="phone-markup-kind-amount" />
            {copy.markupKindAmount}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="none" id="phone-markup-kind-none" />
            {copy.markupKindNone}
          </label>
        </RadioGroup>
        {kind !== 'none' && (
          <div className="space-y-2">
            <Label htmlFor="phone-markup-value">
              {kind === 'percent' ? copy.markupPercentLabel : fill(copy.markupAmountLabel, { currency })}
            </Label>
            <Input
              id="phone-markup-value"
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
            {copy.cancel}
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

function WholesaleDialog({
  open,
  currency,
  initialValue,
  markup,
  isMutating,
  onClose,
  onSave,
}: Readonly<{
  open: boolean;
  currency: string;
  initialValue: string;
  markup: { markupAmount: number | null; markupPercent: string | null };
  isMutating: boolean;
  onClose: () => void;
  onSave: (monthlyPrice: string) => void;
}>) {
  const copy = adminPhonePricingCopy();
  const [value, setValue] = useState(initialValue);
  const customerPreview = customerPriceMajor(value, markup);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
  }, [open, initialValue]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.wholesaleDialogTitle}</DialogTitle>
          <DialogDescription>{copy.wholesaleDialogDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="phone-wholesale">{fill(copy.wholesaleLabel, { currency })}</Label>
          <Input
            id="phone-wholesale"
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {customerPreview && (
            <p className="text-xs text-muted-foreground">
              {fill(copy.customerPreview, { price: formatMoney(customerPreview, currency) })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isMutating}>
            {copy.cancel}
          </Button>
          <Button onClick={() => onSave(value)} disabled={isMutating}>
            {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
            {copy.markupSave}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({
  open,
  isMutating,
  onClose,
  onSave,
}: Readonly<{
  open: boolean;
  isMutating: boolean;
  onClose: () => void;
  onSave: (input: { countryCode: string; numberType: string; monthlyPrice: string }) => void;
}>) {
  const copy = adminPhonePricingCopy();
  const [countryCode, setCountryCode] = useState('');
  const [numberType, setNumberType] = useState('local');
  const [monthlyPrice, setMonthlyPrice] = useState('');

  useEffect(() => {
    if (!open) return;
    setCountryCode('');
    setNumberType('local');
    setMonthlyPrice('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.createDialogTitle}</DialogTitle>
          <DialogDescription>{copy.createDialogDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="phone-create-country">{copy.countryLabel}</Label>
            <Input
              id="phone-create-country"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
              placeholder="NL"
              maxLength={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone-create-type">{copy.typeLabel}</Label>
            <Input
              id="phone-create-type"
              value={numberType}
              onChange={(e) => setNumberType(e.target.value)}
              placeholder="local"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone-create-price">{fill(copy.wholesaleLabel, { currency: 'USD' })}</Label>
            <Input
              id="phone-create-price"
              type="number"
              min="0"
              step="0.01"
              value={monthlyPrice}
              onChange={(e) => setMonthlyPrice(e.target.value)}
              placeholder="5.00"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isMutating}>
            {copy.cancel}
          </Button>
          <Button
            onClick={() => onSave({ countryCode, numberType, monthlyPrice })}
            disabled={isMutating}
          >
            {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
            {copy.createSave}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
