import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { defaultAgencyName, getSalesTaxState } from '@/lib/weldbooks/us-sales-tax-states';
import { useSetupTexts } from '../setup/setup-texts';

/**
 * What the state is known to do: who administers the tax, where a sale is
 * sourced, the usual due day, cash basis and discount, and the programs worth
 * knowing about. From the state table, so it shows before anything is saved.
 * These are the usual rules: the registration notice is the authority.
 */
export function StateInfoPanel({ stateCode, className }: Readonly<{ stateCode: string; className?: string }>) {
  const { t, format } = useSetupTexts();
  const ti = t.wizard.info;
  const state = getSalesTaxState(stateCode);
  if (!state) return null;

  const sourcing =
    state.intrastateSourcing === 'origin'
      ? ti.sourcingOrigin
      : state.intrastateSourcing === 'modified_origin'
        ? ti.sourcingModified
        : ti.sourcingDestination;

  const dueDay = state.defaultDueDay === 'last' ? ti.dueDayLast : format(ti.dueDay, { day: state.defaultDueDay });
  const discount = state.vendorDiscount
    ? state.vendorDiscount.capPerReturn
      ? format(ti.vendorDiscountCapped, { percent: state.vendorDiscount.percent, cap: state.vendorDiscount.capPerReturn })
      : format(ti.vendorDiscount, { percent: state.vendorDiscount.percent })
    : null;

  return (
    <Card className={className} data-testid="state-info-panel">
      <CardHeader>
        <CardTitle className="text-base">{format(ti.title, { state: state.name })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!state.hasStateSalesTax ? <p className="text-muted-foreground">{format(ti.noStateTax, { state: state.name })}</p> : null}
        {state.taxName ? <p className="text-muted-foreground">{format(ti.taxName, { name: state.taxName })}</p> : null}

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ti.agency}</p>
          <p className="font-medium">{defaultAgencyName(state)}</p>
          {state.portalUrl ? (
            <a
              href={state.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              {ti.openPortal}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : null}
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ti.sourcing}</p>
          <p data-testid="state-sourcing">{format(sourcing, { state: state.name })}</p>
        </div>

        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>{ti.sst[state.sst]}</li>
          <li>{state.cashBasisAllowed ? ti.basisAllowed : format(ti.basisAccrualOnly, { state: state.name })}</li>
          <li>{dueDay}</li>
          {discount ? <li>{discount}</li> : null}
        </ul>

        {state.specialPrograms && state.specialPrograms.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ti.programsTitle}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {state.specialPrograms.map((program) => (
                <li key={program}>{ti.programs[program]}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">{ti.verify}</p>
      </CardContent>
    </Card>
  );
}
