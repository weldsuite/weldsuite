/**
 * The parts of a decision the object panel shows: the call to action while it
 * is proposed, the options weighed, and the records it is linked to.
 */

import { Check } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { Decision, DecisionDetail } from '@weldsuite/app-api-client/domains/project-governance';
import { ListCode } from '@/app/weldflow/components/list-cells';
import { useObjectPanel } from '@/components/object-panel';
import { resolveObjectPanel } from '@/components/object-panel/object-panel-registry';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useFormatters } from '../../_lib/use-governance';

/** Who is asked to decide, by when, and whether someone declined; with the button that records it. */
export function ProposedBanner({
  row,
  declined,
  canRecord,
  onDecide,
  memberName,
}: Readonly<{
  row: Decision;
  declined: DecisionDetail['approvals'][number] | undefined;
  canRecord: boolean;
  onDecide: () => void;
  memberName: (id: string | null | undefined) => string;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.decisions;
  const formatters = useFormatters();
  let waiting: string = copy.waitingOpen;
  if (row.deciderId) {
    waiting = row.decisionDueAt
      ? format(copy.waitingNamedDue, { name: memberName(row.deciderId), date: formatters.date(row.decisionDueAt) })
      : format(copy.waitingNamed, { name: memberName(row.deciderId) });
  }
  let declinedText = '';
  if (declined) {
    const name = memberName(declined.approverId);
    declinedText = declined.note ? format(copy.declined, { name, note: declined.note }) : format(copy.declinedNoNote, { name });
  }
  return (
    <InfoBanner
      variant="info"
      action={
        canRecord ? (
          <Button type="button" size="sm" onClick={onDecide}>
            {copy.actions.record}
          </Button>
        ) : undefined
      }
    >
      {waiting}
      {declined ? <span className="mt-1 block text-xs opacity-80">{declinedText}</span> : null}
    </InfoBanner>
  );
}

/** The options weighed, in order; the one taken is ticked. */
export function OptionsList({ options }: Readonly<{ options: Decision['options'] }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  if (options.length === 0) return <p className="text-[13px] text-muted-foreground">{copy.noOptions}</p>;
  return (
    <ol>
      {options.map((option, index) => (
        <li key={`${option.title}-${index}`} className="flex gap-2.5 border-b border-border py-2.5 first:pt-0 last:border-b-0 last:pb-0">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded text-xs font-semibold',
              option.chosen ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200' : 'bg-muted text-muted-foreground',
            )}
          >
            {option.chosen ? <Check className="size-3.5" /> : index + 1}
          </span>
          <div className="min-w-0 text-[13px]">
            <div className="font-medium">
              {option.title}
              {option.chosen ? <span className="font-semibold text-green-700 dark:text-green-400"> · {copy.chosen}</span> : null}
            </div>
            {option.note ? <div className="mt-0.5 text-xs whitespace-pre-line text-muted-foreground">{option.note}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The records a decision is linked to, one row each; one with an object panel (a task, a RAID item, a decision) opens on top of this panel. */
export function LinkedList({ links }: Readonly<{ links: DecisionDetail['links'] }>) {
  const { t } = useI18n();
  const { open } = useObjectPanel();
  const kinds = t.flowGovernance.common.linkKinds;
  return (
    <ul>
      {links.map((link) => {
        const { target } = link;
        const content = (
          <>
            <span className="w-20 shrink-0 text-left text-xs text-muted-foreground">{kinds[target.type]}</span>
            {target.code ? <ListCode code={target.code} /> : null}
            <span className="min-w-0 flex-1 truncate text-left text-[13px]">{target.title}</span>
          </>
        );
        return (
          <li key={link.id} className="border-b border-border last:border-b-0">
            {resolveObjectPanel(target.type) ? (
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start gap-2.5 rounded-none px-6 py-2.5 font-normal"
                onClick={() => open({ type: target.type, id: target.id, stack: true })}
              >
                {content}
              </Button>
            ) : (
              <div className="flex items-center gap-2.5 px-6 py-2.5">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
