import { AlarmClock, Gauge } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { SelectPropertyRow } from '@/components/objects/_shared/select-property-row';
import {
  DESK_LEVELS,
  useDeskAttributeOptions,
  type DeskAttributesUpdate,
  type DeskConversation,
  type DeskLevel,
} from '@/hooks/queries/use-desk-queries';
import { priorityFromMatrix } from '@/hooks/queries/use-desk-priority-matrix-queries';

/**
 * Impact and urgency (ITIL) in the ticket fields, as property rows. With the workspace's
 * priority matrix on, the server sets the priority from them whenever either
 * changes; the line under them says whether the priority follows the grid or
 * was set by hand.
 */
export function ImpactUrgencyFields({
  conversation,
  save,
}: Readonly<{ conversation: DeskConversation; save: (data: DeskAttributesUpdate) => void }>) {
  const t = getTranslations('helpdesk').priorityMatrix;
  const inbox = getTranslations('deskInbox2');
  const { data: options } = useDeskAttributeOptions();
  const matrix = options?.priorityMatrix;
  const levels = DESK_LEVELS.map((level) => ({ value: level, label: t.levels[level] }));
  const derived = matrix?.enabled
    ? priorityFromMatrix(matrix.matrix, conversation.impact, conversation.urgency)
    : null;

  let hint: string | null = null;
  if (derived && conversation.priority === derived) hint = t.derived;
  else if (derived) hint = t.overridden.replace('{priority}', inbox.ticket.priorities[derived]);

  return (
    <>
      <SelectPropertyRow
        icon={Gauge}
        label={t.impact}
        value={conversation.impact}
        options={levels}
        onChange={(impact) => save({ impact: impact as DeskLevel | null })}
        placeholder={t.notSet}
      />
      <SelectPropertyRow
        icon={AlarmClock}
        label={t.urgency}
        value={conversation.urgency}
        options={levels}
        onChange={(urgency) => save({ urgency: urgency as DeskLevel | null })}
        placeholder={t.notSet}
      />
      {hint && (
        // Lined up under the values: the 120px label column plus the row's gap.
        <p className="pl-[128px] pb-1 text-xs text-muted-foreground" data-testid="desk-ticket-priority-source">
          {hint}
        </p>
      )}
    </>
  );
}
