import { EntityChat } from '@/components/entity-chat/entity-chat';

interface TaskChatProps {
  taskId: string;
  taskTitle?: string;
}

/**
 * Back-compat wrapper — the real implementation lives in EntityChat.
 *
 * The double `flex flex-col` shell mirrors `CustomerChatPanel` so the chat
 * fills the host container correctly when mounted inside the bottom
 * sidebar slot of `EntityDetailView` (which is itself a flex item with
 * `min-h-0 overflow-hidden`). Without the outer wrappers the EntityChat's
 * `h-full` ends up resolving to zero in some Safari/Chrome flex edge cases,
 * which leaves the chat invisible despite being mounted.
 */
export function TaskChat({ taskId, taskTitle }: TaskChatProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <EntityChat entityType="task" entityId={taskId} fallbackName={taskTitle} hideHeader />
      </div>
    </div>
  );
}
