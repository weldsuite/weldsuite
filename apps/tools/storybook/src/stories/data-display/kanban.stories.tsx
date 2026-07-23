import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import {
  KanbanProvider,
  KanbanBoard,
  KanbanHeader,
  KanbanCards,
  KanbanCard,
  type KanbanItemProps,
  type KanbanColumnProps,
} from '@weldsuite/ui/components/kanban';

const meta = {
  title: 'Data Display/Kanban',
  component: KanbanProvider,
} satisfies Meta<typeof KanbanProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

const columns: KanbanColumnProps[] = [
  { id: 'todo', name: 'To Do' },
  { id: 'doing', name: 'In Progress' },
  { id: 'done', name: 'Done' },
];

const initialData: KanbanItemProps[] = [
  { id: '1', name: 'Design schema', column: 'todo' },
  { id: '2', name: 'Build API', column: 'doing' },
  { id: '3', name: 'Write tests', column: 'doing' },
  { id: '4', name: 'Ship it', column: 'done' },
];

export const Default: Story = {
  render: () => {
    const [data, setData] = useState(initialData);
    return (
      <div className="h-[400px]">
        <KanbanProvider columns={columns} data={data} onDataChange={setData}>
          {(column) => (
            <KanbanBoard id={column.id} key={column.id}>
              <KanbanHeader>{column.name}</KanbanHeader>
              <KanbanCards id={column.id}>
                {(item: KanbanItemProps) => (
                  <KanbanCard key={item.id} {...item} />
                )}
              </KanbanCards>
            </KanbanBoard>
          )}
        </KanbanProvider>
      </div>
    );
  },
};
