'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Globe, Loader2, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { backfillDomainPricing } from '@/actions/domain-pricing';
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
  const [isMutating, startMutation] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^\./, '');
    if (!q) return rows;
    return rows.filter((r) => r.tld.toLowerCase().includes(q));
  }, [rows, search]);

  function runBackfill() {
    startMutation(async () => {
      const result = await backfillDomainPricing();
      if (result.ok) {
        const { inserted, skipped, fetched } = result.data;
        toast.success(
          inserted
            ? `Backfilled ${inserted} TLD${inserted === 1 ? '' : 's'} from Realtime Register (${fetched} on pricelist, ${skipped} already in catalog)`
            : `Catalog already complete — ${fetched} TLDs on the pricelist, none missing`,
        );
        setConfirm(false);
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
              Domain pricing
            </span>
          }
          description="Master catalog used by WeldHost search and checkout. Backfill missing TLDs from the Realtime Register pricelist — existing rows and markup are left alone."
          actions={
            <Button size="sm" onClick={() => setConfirm(true)} disabled={isMutating}>
              {isMutating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Backfill from Realtime Register
            </Button>
          }
        />

        <div className="grid grid-cols-3 gap-3">
          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">Catalog</p>
              <p className="mt-1 text-lg font-medium tabular-nums">{stats.total}</p>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">Active</p>
              <p className="mt-1 text-lg font-medium tabular-nums">{stats.active}</p>
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs text-muted-foreground">Popular</p>
              <p className="mt-1 text-lg font-medium tabular-nums">{stats.popular}</p>
            </CardContent>
          </Card>
        </div>

        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter TLD…"
            className="pl-9"
          />
        </div>

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="[&_tr]:border-border/70">
              <TableRow>
                <TableHead className="text-[13.5px]">TLD</TableHead>
                <TableHead className="text-right text-[13.5px]">Register</TableHead>
                <TableHead className="text-right text-[13.5px]">Renew</TableHead>
                <TableHead className="text-right text-[13.5px]">Transfer</TableHead>
                <TableHead className="text-[13.5px]">Markup</TableHead>
                <TableHead className="text-[13.5px]">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr]:border-border/70">
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    {rows.length === 0
                      ? 'No domain pricing yet. Backfill from Realtime Register to populate the catalog.'
                      : 'No TLDs match that filter.'}
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((row) => (
                <TableRow key={row.id} className="h-10 hover:bg-muted/50">
                  <TableCell className="py-2 font-mono text-sm">.{row.tld.replace(/^\./, '')}</TableCell>
                  <TableCell className="py-2 text-right tabular-nums">
                    {formatMoney(row.registrationPrice, row.currency)}
                  </TableCell>
                  <TableCell className="py-2 text-right tabular-nums">
                    {formatMoney(row.renewalPrice, row.currency)}
                  </TableCell>
                  <TableCell className="py-2 text-right tabular-nums">
                    {formatMoney(row.transferPrice, row.currency)}
                  </TableCell>
                  <TableCell className="py-2 tabular-nums text-sm">{markupLabel(row)}</TableCell>
                  <TableCell className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {row.isActive ? (
                        <Badge variant="secondary">active</Badge>
                      ) : (
                        <Badge variant="outline">inactive</Badge>
                      )}
                      {row.isPopular && <Badge variant="outline">popular</Badge>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </PageBody>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backfill domain pricing?</DialogTitle>
            <DialogDescription>
              This calls Realtime Register <code>GET /v2/customers/…/pricelist</code> (EUR) and
              inserts any TLDs that are not already in the master catalog. Existing rows, including
              markup, are not overwritten.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={isMutating}>
              Cancel
            </Button>
            <Button onClick={runBackfill} disabled={isMutating}>
              {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
              Fetch pricelist
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}
