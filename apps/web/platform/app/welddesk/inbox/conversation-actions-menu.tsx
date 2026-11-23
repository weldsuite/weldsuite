import { useState, type ReactNode } from 'react';
import { EllipsisVertical, FilePlus2, ListTodo } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@weldsuite/permissions/react';
import { HeaderIconButton } from '@weldsuite/ui/components/header-icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { useCreateDraftArticle } from '@/hooks/queries/use-desk-knowledge-queries';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { useDeskConversation, type DeskConversation } from '@/hooks/queries/use-desk-queries';
import { TICKET_TASK_SOURCE, ticketTaskKeys } from '@/hooks/queries/use-ticket-tasks-queries';
import { ticketTaskDefaults } from './ticket-task-defaults';
import { TranslateMenuItem } from './translation/translate-toggle';
import { useDeskTranslationAvailable } from './translation/translation-state';

interface ConversationActionsMenuProps {
  conversation: DeskConversation;
  /** More items for the menu (other ticket actions). */
  children?: ReactNode;
}

/**
 * The conversation header's "more actions" menu. Its own items: "Translate"
 * (the customer's messages in the agent's language, on or off), "Create task",
 * a WeldFlow task prefilled from the ticket and linked to it (the details
 * panel lists it, the task links back), and "Create article", a help-center
 * draft from the customer's question and the team's public answers, opened in
 * the editor.
 */
export function ConversationActionsMenu({ conversation, children }: Readonly<ConversationActionsMenuProps>) {
  const t = getTranslations('helpdesk').ticketTasks;
  const k = getTranslations('helpdesk').knowledgeInbox;
  const qc = useQueryClient();
  const router = useRouter();
  const { can } = usePermissions();
  const canCreateTask = can('tasks:create');
  const canCreateArticle = can('articles:create');
  const canTranslate = useDeskTranslationAvailable();
  const draftArticle = useCreateDraftArticle();
  // The pane already holds the thread; this reads it from the cache.
  const { data } = useDeskConversation(conversation.id);
  const [taskOpen, setTaskOpen] = useState(false);

  if (!canTranslate && !canCreateTask && !canCreateArticle && !children) return null;

  const createArticle = async () => {
    try {
      const article = await draftArticle.mutateAsync(conversation.id);
      toast.success(k.articleCreated);
      router.push(`/welddesk/help-center/articles/${article.id}/edit`);
    } catch {
      toast.error(k.createArticleFailed);
    }
  };

  const defaults = ticketTaskDefaults(conversation, data?.data?.messages ?? [], t);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HeaderIconButton label={t.moreActions} data-testid="desk-inbox-conversation-actions">
            <EllipsisVertical />
          </HeaderIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <TranslateMenuItem conversationId={conversation.id} />
          {canCreateTask && (
            <DropdownMenuItem onSelect={() => setTaskOpen(true)} data-testid="desk-inbox-create-task">
              <ListTodo className="h-4 w-4" />
              {t.createTask}
            </DropdownMenuItem>
          )}
          {canCreateArticle && (
            <DropdownMenuItem
              onSelect={() => void createArticle()}
              disabled={draftArticle.isPending}
              title={k.createArticleHint}
              data-testid="desk-inbox-create-article"
            >
              <FilePlus2 className="h-4 w-4" />
              {k.createArticle}
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
