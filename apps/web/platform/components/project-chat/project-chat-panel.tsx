import { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { EntityChat } from '@/components/entity-chat/entity-chat';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useProjectMembers } from '@/hooks/queries/use-projects-queries';
import { BookmarksPopover } from '@/app/weldchat/components/bookmarks-popover';
import { ChatFiltersButton } from '@/app/weldchat/components/chat-filters-button';
import { cn } from '@/lib/utils';

interface ProjectChatPanelProps {
  projectId: string;
  projectName?: string;
}

const MAX_VISIBLE_AVATARS = 4;

export function ProjectChatPanel({ projectId, projectName }: ProjectChatPanelProps) {
  const { data: membersData } = useProjectMembers(projectId);
  const members: Array<{
    userId: string;
    user?: { name?: string; email?: string; avatar?: string };
  }> = membersData?.data ?? [];

  const visible = members.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = members.slice(MAX_VISIBLE_AVATARS);

  const [bookmarksOpen, setBookmarksOpen] = useState(false);

  const header = (
    <div className="flex h-[53px] flex-shrink-0 items-center justify-between gap-2 border-b px-4">
      <div className="flex items-center min-w-0">
        {members.length > 0 && (
          <div className="flex -space-x-1.5">
            {visible.map((m) => {
              const label = m.user?.name || m.user?.email || '?';
              return (
                <Tooltip key={m.userId} delayDuration={150}>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Avatar className="h-[22px] w-[22px] !rounded-[7px] ring-1 ring-background">
                        {m.user?.avatar && (
                          <AvatarImage src={m.user.avatar} alt={label} className="!rounded-[7px]" />
                        )}
                        <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {label.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {overflow.length > 0 && (
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <div className="w-[22px] h-[22px] rounded bg-gray-300 dark:bg-accent flex items-center justify-center ring-1 ring-background">
                      <span className="text-[9px] font-medium text-gray-600 dark:text-muted-foreground">
                        +{overflow.length}
                      </span>
                    </div>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  <div className="flex flex-col gap-0.5">
                    {overflow.map((m) => (
                      <span key={m.userId}>{m.user?.name || m.user?.email || '?'}</span>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <ChatFiltersButton />
        <Popover open={bookmarksOpen} onOpenChange={setBookmarksOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-8 w-8', bookmarksOpen && 'bg-accent')}
              title="Bookmarks"
            >
              <Bookmark className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="bottom"
            sideOffset={4}
            className="w-[380px] p-0 max-h-[70vh] flex flex-col"
          >
            <BookmarksPopover onClose={() => setBookmarksOpen(false)} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col">
        <EntityChat
          entityType="project"
          entityId={projectId}
          fallbackName={projectName}
          hideHeader
          headerSlot={header}
        />
      </div>
    </div>
  );
}
