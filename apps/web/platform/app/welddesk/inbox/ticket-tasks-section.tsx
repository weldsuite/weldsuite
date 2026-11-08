import { Loader2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { normalizeTaskStatus } from '@weldsuite/app-api-client/schemas/tasks';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { useTicketTasks, type TicketTask } from '@/hooks/queries/use-ticket-tasks-queries';

/** `sweep.shared.taskStatus`. */
type StatusLabels = Record<'backlog' | 'todo' | 'inProgress' | 'inReview' | 'testing' | 'done' | 'cancelled', string>;

const STATUS_LABEL_KEYS: Record<string, keyof StatusLabels> = {
  backlog: 'backlog',
  todo: 'todo',
  in_progress: 'inProgress',
  review: 'inReview',
  testing: 'testing',
  done: 'done',
  cancelled: 'cancelled',
};

function statusTone(status: string): SoftTone {
  if (status === 'done') return 'success';
  if (status === 'cancelled') return 'neutral';
  if (status === 'in_progress' || status === 'review' || status === 'testing') return 'warning';
  return 'neutral';
}

function TicketTaskRow({ task, labels }: Readonly<{ task: TicketTask; labels: StatusLabels }>) {
  const t = getTranslations('helpdesk').ticketTasks;
  const status = normalizeTaskStatus(task.status);
  const labelKey = STATUS_LABEL_KEYS[status];
  const assigneeName = task.assignee?.name || task.assignee?.email || null;
  return (
    <li>
      <Link
        href={`/weldflow/task/${task.id}`}
        className="block rounded-md px-2 py-1.5 -mx-2 hover:bg-muted transition-colors"
        title={t.openTask}
        data-testid="desk-inbox-ticket-task"
      >
        <span className="block text-sm font-medium truncate">{task.title}</span>
        <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <SoftBadge tone={statusTone(status)} className="px-1.5 py-0 text-[11px] font-normal">
            {labelKey ? labels[labelKey] : status}
          </SoftBadge>
          <span className="ml-auto inline-flex items-center gap-1.5 min-w-0">
            {assigneeName && (
              <Avatar className="h-4 w-4">
                {task.assignee?.avatar && <AvatarImage src={task.assignee.avatar} />}
                <AvatarFallback className="text-[9px]">{assigneeName.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
            )}
            <span className="truncate">{assigneeName ?? t.unassigned}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The WeldFlow tasks created from this ticket (status, assignee, a link to
 * each). Left out entirely for a member who can't read tasks.
 */
export function TicketTasksSection({ conversationId }: Readonly<{ conversationId: string }>) {
  const t = getTranslations('helpdesk').ticketTasks;
  const statusLabels = getTranslations('sweep').shared.taskStatus;
  const { can } = usePermissions();
  const allowed = can('tasks:read');
  const { data: tasks, isLoading, isError } = useTicketTasks(conversationId, allowed);

  if (!allowed || isError) return null;

  return (
    <div className="px-4 py-3 border-b border-border/60" data-testid="desk-inbox-ticket-tasks">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">{t.title}</p>
      {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {!isLoading && (tasks ?? []).length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      <ul className="space-y-1">
        {(tasks ?? []).map((task) => (
          <TicketTaskRow key={task.id} task={task} labels={statusLabels} />
        ))}
      </ul>
    </div>
  );
}
