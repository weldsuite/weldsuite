import { useState, type ReactNode } from 'react';
import { ListTodo, MoreHorizontal } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { getTranslations } from '@/lib/i18n';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { useDeskConversation, type DeskConversation } from '@/hooks/queries/use-desk-queries';
import { TICKET_TASK_SOURCE, ticketTaskKeys } from '@/hooks/queries/use-ticket-tasks-queries';
import { ticketTaskDefaults } from './ticket-task-defaults';

interface ConversationActionsMenuProps {
  conversation: DeskConversation;
  /** More items for the menu (other ticket actions). */
  children?: ReactNode;
}

/**
 * The conversation header's "more actions" menu. Its own item: "Create task",
 * a WeldFlow task prefilled from the ticket and linked to it (the details
 * panel lists it, the task links back).
 */
export function ConversationActionsMenu({ conversation, children }: Readonly<ConversationActionsMenuProps>) {
  const t = getTranslations('helpdesk').ticketTasks;
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canCreateTask = can('tasks:create');
  // The pane already holds the thread; this reads it from the cache.
  const { data } = useDeskConversation(conversation.id);
  const [taskOpen, setTaskOpen] = useState(false);

  if (!canCreateTask && !children) return null;

  const defaults = ticketTaskDefaults(conversation, data?.data?.messages ?? [], t);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
            aria-label={t.moreActions}
            title={t.moreActions}
            data-testid="desk-inbox-conversation-actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {canCreateTask && (
            <DropdownMenuItem onSelect={() => setTaskOpen(true)} data-testid="desk-inbox-create-task">
              <ListTodo className="h-4 w-4" />
              {t.createTask}
            </DropdownMenuItem>
          )}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {canCreateTask && (
        <CreateTaskDialog
          open={taskOpen}
          onOpenChange={setTaskOpen}
          defaultTitle={defaults.title}
          defaultDescription={defaults.description}
          source={{ type: TICKET_TASK_SOURCE, id: conversation.id }}
          onTaskCreated={() => {
            void qc.invalidateQueries({ queryKey: ticketTaskKeys.forConversation(conversation.id) });
          }}
        />
      )}
    </>
  );
}
