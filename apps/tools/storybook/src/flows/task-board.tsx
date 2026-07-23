import * as React from 'react';

import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
  type KanbanColumnProps,
} from '@weldsuite/ui/components/kanban';

import { PRIORITY_LABELS, type Task, type TaskPriority } from '../mocks/data';

const PRIORITY_VARIANT: Record<TaskPriority, React.ComponentProps<typeof Badge>['variant']> = {
  low: 'outline',
  medium: 'secondary',
  high: 'default',
  urgent: 'destructive',
};

/**
 * The WeldFlow task kanban — `@weldsuite/ui`'s KanbanProvider wired with styled
 * task cards (assignee + priority). Drag-and-drop between columns updates the
 * caller's `data` via `onDataChange`. Used by the WeldFlow flow stories.
 */
export function TaskBoard({
  columns,
  data,
  onDataChange,
}: {
  columns: KanbanColumnProps[];
  data: Task[];
  onDataChange: (data: Task[]) => void;
}) {
  return (
    <div className="h-full overflow-x-auto p-4">
      <KanbanProvider
        columns={columns}
        data={data}
        onDataChange={(d) => onDataChange(d as Task[])}
        className="gap-3"
      >
        {(column) => {
          const count = data.filter((t) => t.column === column.id).length;
          return (
            <KanbanBoard id={column.id} key={column.id} className="rounded-lg bg-muted/40">
              <KanbanHeader className="flex items-center justify-between">
                <span>{column.name}</span>
                <span className="rounded bg-background px-1.5 text-[10px] font-mono text-muted-foreground">
                  {count}
                </span>
              </KanbanHeader>
              <KanbanCards id={column.id}>
                {(item: Task) => (
                  <KanbanCard key={item.id} {...item}>
                    <div className="space-y-2.5">
                      <p className="m-0 text-sm font-medium leading-snug">{item.name}</p>
                      <div className="flex items-center justify-between">
                        <Badge variant={PRIORITY_VARIANT[item.priority]} className="text-[10px]">
                          {PRIORITY_LABELS[item.priority]}
                        </Badge>
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="text-[10px]">
                            {item.assigneeInitials}
                          </AvatarFallback>
                        </Avatar>
                      </div>
                    </div>
                  </KanbanCard>
                )}
              </KanbanCards>
            </KanbanBoard>
          );
        }}
      </KanbanProvider>
    </div>
  );
}
