/**
 * After a line was booked to a category: a small inline offer to save how it
 * was booked as a rule. The suggestion comes from the history of the same
 * counterparty; without one, "Make this a rule" asks the server for a pre-fill
 * from this line. Either way the existing rule form opens, pre-filled, and
 * nothing is saved until the person saves it there.
 */

import { Wand2, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useRuleFromTransaction, useRuleSuggestion } from '@/hooks/queries/use-weldbooks-processing-queries';
import type { RuleFormPrefill, RulePrefill } from '@/lib/api/domains/weldbooks-processing';
import { useI18n } from '@/lib/i18n/provider';

export function toRuleFormPrefill(prefill: RulePrefill): RuleFormPrefill {
  return {
    name: prefill.name,
    matchMode: prefill.matchMode,
    conditions: prefill.conditions,
    actions: prefill.actions,
  };
}

export interface RuleOfferProps {
  lineId: string;
  counterpartyName: string | null;
  canCreate: boolean;
  onMakeRule: (prefill: RuleFormPrefill) => void;
}

export function RuleOffer({ lineId, counterpartyName, canCreate, onMakeRule }: Readonly<RuleOfferProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksConnected.processing.rule;
  const suggestion = useRuleSuggestion(lineId).data ?? null;
  const fromLine = useRuleFromTransaction();

  if (!canCreate) return null;

  const make = () => {
    if (suggestion) {
      onMakeRule(toRuleFormPrefill(suggestion));
      return;
    }
    fromLine.mutate(lineId, { onSuccess: (prefill) => onMakeRule(toRuleFormPrefill(prefill)) });
  };

  let text = tr.offerPlain;
  if (suggestion) {
    text = tr.offer
      .replace('{name}', counterpartyName ?? suggestion.name)
      .replace('{times}', String(suggestion.evidence.times));
  }

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm"
      data-testid="rule-offer"
    >
      <Wand2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
      <Button type="button" variant="outline" size="sm" onClick={make} disabled={fromLine.isPending}>
        {fromLine.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
        {fromLine.isPending ? tr.preparing : tr.make}
      </Button>
      {fromLine.isError ? (
        <p className="w-full text-xs text-destructive" role="alert" data-testid="rule-offer-error">
          {tr.failed}
        </p>
      ) : null}
    </div>
  );
}
