/**
 * Receive goods on a purchase order (Kubernetes editions: the Rust backend's
 * `POST /purchase-orders/{id}/receive`).
 *
 * One row per line that still has something to receive: quantity and rejected
 * (prefilled with what remains), a location, and a lot and expiry date where
 * the product tracks them. The request carries an idempotency key: one per
 * submit, kept if the same submit is retried (a dropped connection must not
 * post stock twice) and replaced as soon as the user changes anything.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { PurchaseOrder, PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import {
  useProductTracking,
  useReceivePurchaseOrder,
  useWarehouseLocations,
} from '@/hooks/queries/use-purchasing-queries';
import {
  buildReceiveLines,
  initialReceiveRows,
  newIdempotencyKey,
  validateReceiveRow,
  type ReceiveRow,
  type ReceiveRowIssue,
} from '../lib/receive';

const DEFAULT_LOCATION = '__default__';

interface ReceiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Pick<PurchaseOrder, 'id' | 'poNumber' | 'warehouseId' | 'warehouseName'>;
  lines: readonly PurchaseOrderLine[];
}

export function ReceiveDialog({ open, onOpenChange, order, lines }: Readonly<ReceiveDialogProps>) {
  const t = getTranslations('weldstashPurchasing').receive;
  const receive = useReceivePurchaseOrder();
  const locations = useWarehouseLocations(order.warehouseId, open);
  const productIds = useMemo(() => lines.map((l) => l.productId).filter((id): id is string => !!id), [lines]);
  const { tracking } = useProductTracking(productIds, open);

  // Rows start from the lines; tracking arrives a moment later and fills the
  // lot and expiry fields in without losing what was typed.
  const [edits, setEdits] = useState<Record<string, Partial<ReceiveRow>>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const keyRef = useRef(newIdempotencyKey());

  const rows = useMemo(
    () => initialReceiveRows(lines, tracking).map((row) => ({ ...row, ...edits[row.itemId] })),
    [lines, tracking, edits],
  );

  /** Any change means a different request, so it gets a different key. */
  const touch = useCallback(() => {
    keyRef.current = newIdempotencyKey();
    setError(null);
  }, []);

  const setRow = (itemId: string, patch: Partial<ReceiveRow>) => {
    touch();
    setEdits((current) => ({ ...current, [itemId]: { ...current[itemId], ...patch } }));
  };

  const issues = useMemo(() => new Map(rows.map((row) => [row.itemId, validateReceiveRow(row)])), [rows]);
  const requestLines = buildReceiveLines(rows);
  const hasIssue = [...issues.values()].some((issue) => issue !== null);
  const needsWarehouse = !order.warehouseId && rows.some((row) => row.productId && requestLines.some((l) => l.itemId === row.itemId && l.quantity > 0));

  const issueText = (issue: ReceiveRowIssue): string =>
    ({ invalid_number: t.issueNumber, over_receipt: t.issueOver, lot_required: t.issueLot })[issue];

  const submit = async () => {
    setShowIssues(true);
    if (hasIssue || requestLines.length === 0 || needsWarehouse) return;
    setError(null);
    try {
      await receive.mutateAsync({
        id: order.id,
        data: { idempotencyKey: keyRef.current, lines: requestLines, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      });
      toast.success(t.toastReceived);
      keyRef.current = newIdempotencyKey();
      setEdits({});
      setNotes('');
      setShowIssues(false);
      onOpenChange(false);
    } catch (err) {
      // The key stays: retrying the same submit posts nothing twice.
      setError((err as Error).message || t.failed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.title.replace('{number}', order.poNumber)}</DialogTitle>
          <DialogDescription>
            {order.warehouseName ? t.description.replace('{warehouse}', order.warehouseName) : t.descriptionNoWarehouse}
          </DialogDescription>
        </DialogHeader>

        {needsWarehouse && <InfoBanner variant="warning">{t.noWarehouse}</InfoBanner>}

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t.nothingToReceive}</p>}
          {rows.map((row) => {
            const issue = showIssues ? issues.get(row.itemId) : null;
            return (
              <div key={row.itemId} className="rounded-md border p-3" data-testid={`receive-row-${row.itemId}`}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">
                    {row.name}
                    {row.sku && <span className="ml-2 font-normal text-muted-foreground">{row.sku}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">{t.remaining.replace('{count}', String(row.remaining))}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <div className="grid gap-1">
                    <Label htmlFor={`qty-${row.itemId}`}>{t.quantity}</Label>
                    <Input
                      id={`qty-${row.itemId}`}
                      inputMode="numeric"
                      value={row.quantity}
                      onChange={(e) => setRow(row.itemId, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`rej-${row.itemId}`}>{t.rejected}</Label>
                    <Input
                      id={`rej-${row.itemId}`}
                      inputMode="numeric"
                      value={row.rejected}
                      onChange={(e) => setRow(row.itemId, { rejected: e.target.value })}
                    />
                  </div>
                  {row.productId && (
                    <div className="grid gap-1 sm:col-span-2">
                      <Label>{t.location}</Label>
                      <Select
                        value={row.locationId || DEFAULT_LOCATION}
                        onValueChange={(value) => setRow(row.itemId, { locationId: value === DEFAULT_LOCATION ? '' : value })}
                      >
                        <SelectTrigger aria-label={t.location}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DEFAULT_LOCATION}>{t.defaultLocation}</SelectItem>
                          {(locations.data ?? []).map((location) => (
                            <SelectItem key={location.id} value={location.id}>
                              {location.name ? `${location.code} · ${location.name}` : location.code}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {row.trackLots && (
                    <div className="grid gap-1 sm:col-span-2">
                      <Label htmlFor={`lot-${row.itemId}`}>{t.lot}</Label>
                      <Input
                        id={`lot-${row.itemId}`}
                        value={row.lotNumber}
                        onChange={(e) => setRow(row.itemId, { lotNumber: e.target.value })}
                      />
                    </div>
                  )}
                  {(row.trackLots || row.trackExpiry) && (
                    <div className="grid gap-1 sm:col-span-2">
                      <Label htmlFor={`exp-${row.itemId}`}>{t.expiry}</Label>
                      <Input
                        id={`exp-${row.itemId}`}
                        type="date"
                        value={row.expiryDate}
                        onChange={(e) => setRow(row.itemId, { expiryDate: e.target.value })}
                      />
                    </div>
                  )}
                </div>
                {issue && <InlineError className="mt-2">{issueText(issue)}</InlineError>}
              </div>
            );
          })}
        </div>

        <div className="grid gap-1">
          <Label htmlFor="receive-notes">{t.notes}</Label>
          <Textarea id="receive-notes" rows={2} value={notes} onChange={(e) => { touch(); setNotes(e.target.value); }} />
        </div>

        {error && <InlineError>{error}</InlineError>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={receive.isPending || rows.length === 0}>
            {receive.isPending ? t.receiving : t.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
