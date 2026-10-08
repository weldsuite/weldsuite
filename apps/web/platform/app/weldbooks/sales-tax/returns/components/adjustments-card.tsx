import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useUpdateTaxReturn } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  ADJUSTMENT_TYPES,
  type AdjustmentType,
  type ReturnAdjustment,
  type TaxReturnDetail,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { Notice } from '../../shared/notice';
import { fill } from '../../shared/text';
import {
  draftsFromAdjustments,
  draftsMatch,
  draftsToAdjustments,
  draftsTotals,
  emptyDraft,
  invalidDraftIds,
  parseAmount,
  returnTotals,
  unusualSign,
  type AdjustmentDraft,
} from '../return-model';

const DEFAULT_ACCOUNT = 'default';

interface AdjustmentRowProps {
  draft: AdjustmentDraft;
  accounts: ReadonlyArray<{ id: string; code: string; name: string }>;
  showErrors: boolean;
  proposedHint: string;
  onChange: (id: string, patch: Partial<AdjustmentDraft>) => void;
  onRemove: (id: string) => void;
}

function AdjustmentRow({ draft, accounts, showErrors, proposedHint, onChange, onRemove }: Readonly<AdjustmentRowProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.salesTax.center.returnPage.adjustments;
  const types = ta.types as Record<AdjustmentType, string>;
  const parsed = parseAmount(draft.amount);
  const invalid = parsed === null && (showErrors || draft.amount.trim() !== '');
  const sign = unusualSign(draft.type, parsed);
  const fieldId = `adjustment-${draft.id}`;
  // Any edit makes a proposal the user's own: the server then stops refreshing it.
  const edit = (patch: Partial<AdjustmentDraft>) => onChange(draft.id, { ...patch, auto: false });

  return (
    <div className="space-y-1.5 rounded-md border p-3" data-testid="adjustment-row">
      <div className="grid gap-2 sm:grid-cols-[11rem_9rem_1fr_auto] sm:items-start">
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-type`} className="sm:sr-only">
            {ta.typeColumn}
          </Label>
          <Select value={draft.type} onValueChange={(value) => edit({ type: value as AdjustmentType })}>
            <SelectTrigger id={`${fieldId}-type`} aria-label={ta.typeColumn}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADJUSTMENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {types[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-amount`} className="sm:sr-only">
            {ta.amountColumn}
          </Label>
          <Input
            id={`${fieldId}-amount`}
            inputMode="decimal"
            className="text-right tabular-nums"
            placeholder={ta.amountPlaceholder}
            aria-label={ta.amountColumn}
            aria-invalid={invalid}
            value={draft.amount}
            onChange={(event) => edit({ amount: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-note`} className="sm:sr-only">
            {ta.noteColumn}
          </Label>
          <Input
            id={`${fieldId}-note`}
            maxLength={255}
            placeholder={ta.notePlaceholder}
            aria-label={ta.noteColumn}
            value={draft.note}
            onChange={(event) => edit({ note: event.target.value })}
          />
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={ta.remove} onClick={() => onRemove(draft.id)}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {draft.type === 'other' ? (
        <div className="space-y-1 sm:max-w-sm">
          <Label htmlFor={`${fieldId}-account`} className="text-xs text-muted-foreground">
            {ta.accountLabel}
          </Label>
          <Select
            value={draft.accountId || DEFAULT_ACCOUNT}
            onValueChange={(value) => edit({ accountId: value === DEFAULT_ACCOUNT ? '' : value })}
          >
            <SelectTrigger id={`${fieldId}-account`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_ACCOUNT}>{ta.accountDefault}</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.code} {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {draft.auto ? (
          <>
            <Badge variant="warning">{ta.proposed}</Badge>
            <p className="text-xs text-muted-foreground">{proposedHint}</p>
          </>
        ) : null}
        {invalid ? <p className="text-xs text-destructive">{ta.invalidAmount}</p> : null}
        {sign && !invalid ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {draft.type === 'vendor_discount' || draft.type === 'prepayment' ? ta.usuallyNegative : ta.usuallyPositive}
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface TotalsPanelProps {
  salesTaxPayable: number;
  useTaxPayable: number;
  adjustmentsTotal: number;
  totalDue: number;
}

/** The sum behind the amount paid: tax payable, the adjustments and the total due. */
export function TotalsPanel({ salesTaxPayable, useTaxPayable, adjustmentsTotal, totalDue }: Readonly<TotalsPanelProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.salesTax.center.returnPage.adjustments;
  const { formatMoney } = useWeldbooksFormat();
  return (
    <dl className="ml-auto w-full max-w-sm space-y-1 text-sm" data-testid="return-totals">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">{ta.payableSales}</dt>
        <dd className="tabular-nums">{formatMoney(salesTaxPayable)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">{ta.payableUse}</dt>
        <dd className="tabular-nums">{formatMoney(useTaxPayable)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">{ta.adjustmentsTotal}</dt>
        <dd className="tabular-nums">{formatMoney(adjustmentsTotal)}</dd>
      </div>
      <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
        <dt>{ta.totalDue}</dt>
        <dd className="tabular-nums" data-testid="total-due">
          {formatMoney(totalDue)}
        </dd>
      </div>
    </dl>
  );
}

interface AdjustmentsCardProps {
  ret: TaxReturnDetail;
  /** The user may change the adjustments (taxes:update) and the return is not filed. */
  canEdit: boolean;
}

/** The adjustments of a calculated return and the total due they lead to; editable until the return is filed. */
export function AdjustmentsCard({ ret, canEdit }: Readonly<AdjustmentsCardProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.salesTax.center.returnPage.adjustments;
  const types = ta.types as Record<AdjustmentType, string>;
  const tt = t.weldbooksUs.salesTax.center.returnPage.toasts;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const update = useUpdateTaxReturn(ret.id);
  const stored = ret.adjustments;
  const summary = ret.summary;

  const [drafts, setDrafts] = useState<AdjustmentDraft[]>(() => draftsFromAdjustments(stored));
  const [showErrors, setShowErrors] = useState(false);

  // The stored adjustments changed (a recalculation refreshes the proposed discount, a save): start from them again.
  const storedKey = JSON.stringify(stored ?? []);
  useEffect(() => {
    setDrafts(draftsFromAdjustments(stored));
    setShowErrors(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stored content, not on the array identity
  }, [storedKey]);

  const needsAccounts = canEdit && drafts.some((draft) => draft.type === 'other');
  const accountsQuery = useAccountingAccounts(undefined, { enabled: needsAccounts });
  const accounts = useMemo(
    () => (accountsQuery.data?.data ?? []).filter((account) => account.isActive !== false),
    [accountsQuery.data],
  );

  const dirty = !draftsMatch(drafts, stored);
  const totals = canEdit ? draftsTotals(summary, drafts) : returnTotals(summary, stored ?? []);
  const proposedHint = ret.dueDate ? fill(ta.proposedHint, { date: formatDate(ret.dueDate) }) : ta.proposedHintNoDate;

  const change = (id: string, patch: Partial<AdjustmentDraft>) =>
    setDrafts((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const remove = (id: string) => setDrafts((rows) => rows.filter((row) => row.id !== id));
  const add = () => setDrafts((rows) => [...rows, emptyDraft()]);

  const save = async () => {
    if (invalidDraftIds(drafts).length > 0) {
      setShowErrors(true);
      return;
    }
    try {
      await update.mutateAsync({ adjustments: draftsToAdjustments(drafts) });
      toast.success(tt.adjustmentsSaved);
    } catch (err) {
      toast.error(tt.adjustmentsFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const discard = () => {
    setDrafts(draftsFromAdjustments(stored));
    setShowErrors(false);
  };

  return (
    <Card data-testid="adjustments-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{ta.title}</CardTitle>
        <p className="text-xs text-muted-foreground">{ta.description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit ? (
          <>
            {drafts.length === 0 ? <p className="text-sm text-muted-foreground">{ta.none}</p> : null}
            <div className="space-y-2">
              {drafts.map((draft) => (
                <AdjustmentRow
                  key={draft.id}
                  draft={draft}
                  accounts={accounts}
                  showErrors={showErrors}
                  proposedHint={proposedHint}
                  onChange={change}
                  onRemove={remove}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={add}>
                <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                {ta.add}
              </Button>
              {dirty ? (
                <>
                  <span className="text-xs text-muted-foreground">{ta.unsaved}</span>
                  <Button type="button" size="sm" onClick={() => void save()} disabled={update.isPending}>
                    {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                    {update.isPending ? ta.saving : ta.save}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={update.isPending}>
                    {ta.discard}
                  </Button>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {(stored ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{ta.none}</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {(stored ?? []).map((adjustment: ReturnAdjustment, index) => (
                  <li key={`${adjustment.type}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>
                      <span className="font-medium">{types[adjustment.type] ?? adjustment.type}</span>
                      {adjustment.note ? <span className="ml-2 text-muted-foreground">{adjustment.note}</span> : null}
                    </span>
                    <span className="tabular-nums">{formatMoney(adjustment.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {ret.status === 'filed' || ret.status === 'paid' ? <Notice tone="info">{ta.locked}</Notice> : null}
          </>
        )}

        <TotalsPanel {...totals} />
        {totals.totalDue < 0 ? <Notice tone="warning">{ta.creditNotice}</Notice> : null}
      </CardContent>
    </Card>
  );
}
