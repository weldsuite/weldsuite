import type { PhaseSummary } from '@weldsuite/app-api-client/domains/project-schedule';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { fill, intlLocaleOf, shortDate } from '../../dependencies/_lib/format';

/** The gates that passed, latest first, with the conditions the approvers set. */
export function PastGates({ phases }: Readonly<{ phases: readonly PhaseSummary[] }>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.phases.past;
  const locale = intlLocaleOf(language);
  const passed = phases.filter((phase) => phase.status === 'passed').reverse();

  return (
    <section aria-labelledby="past-title" className="rounded-lg border bg-card p-4">
      <h2 id="past-title" className="text-sm font-semibold">
        {copy.title}
      </h2>
      {passed.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{copy.none}</p>
      ) : (
        <div className="mt-3 grid gap-3">
          {passed.map((phase) => {
            const index = phases.findIndex((other) => other.id === phase.id);
            const next = phases[index + 1];
            const conditions = phase.approvals.filter((approval) => approval.decision === 'approved_with_conditions' && approval.note);
            const waived = phase.gateResult?.waived.length ?? 0;
            return (
              <article key={phase.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {next
                      ? fill(copy.cardTitle, { number: phase.gateNumber, from: phase.name, to: next.name })
                      : fill(copy.cardTitleLast, { number: phase.gateNumber, from: phase.name })}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs',
                      conditions.length > 0 ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
                    )}
                  >
                    {conditions.length > 0 ? copy.approvedWithConditions : copy.approved}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {phase.passedAt ? fill(copy.passedOn, { date: shortDate(phase.passedAt, locale) }) : ''}
                  {waived > 0 ? ` · ${fill(copy.waivedCount, { count: waived })}` : ''}
                </div>
                {conditions.length > 0 && (
                  <ul className="mt-2 grid gap-1 text-xs">
                    {conditions.map((approval) => (
                      <li key={approval.id}>{approval.note}</li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
