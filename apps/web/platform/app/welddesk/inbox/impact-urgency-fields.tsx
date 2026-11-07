import { getTranslations } from '@/lib/i18n';
import {
  DESK_LEVELS,
  useDeskAttributeOptions,
  type DeskAttributesUpdate,
  type DeskConversation,
  type DeskLevel,
} from '@/hooks/queries/use-desk-queries';
import { priorityFromMatrix } from '@/hooks/queries/use-desk-priority-matrix-queries';
import { FieldRow, PickOne } from './ticket-fields';

/**
 * Impact and urgency (ITIL) in the ticket fields. With the workspace's
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
      <FieldRow label={t.impact}>
        <PickOne
          value={conversation.impact}
          noneLabel={t.notSet}
          items={levels}
          onChange={(impact) => save({ impact: impact as DeskLevel | null })}
          testId="desk-ticket-impact"
        />
      </FieldRow>
      <FieldRow label={t.urgency}>
        <PickOne
          value={conversation.urgency}
          noneLabel={t.notSet}
          items={levels}
          onChange={(urgency) => save({ urgency: urgency as DeskLevel | null })}
          testId="desk-ticket-urgency"
        />
      </FieldRow>
      {hint && (
        <p className="text-xs text-muted-foreground text-right pb-1" data-testid="desk-ticket-priority-source">
          {hint}
        </p>
      )}
    </>
  );
}
