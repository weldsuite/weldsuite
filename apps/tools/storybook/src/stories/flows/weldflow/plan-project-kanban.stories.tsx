import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MoveHorizontal } from 'lucide-react';

import { Badge } from '@weldsuite/ui/components/badge';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';

import { AppFrame } from '../../../flows/app-frame';
import { FlowStepper, type FlowStep } from '../../../flows/flow-stepper';
import { TaskBoard } from '../../../flows/task-board';
import { shortDate } from '../../../flows/bits';
import {
  PROJECT_STATUS_LABELS,
  projects,
  taskStages,
  websiteTasks,
  type Project,
  type ProjectStatus,
  type Task,
} from '../../../mocks/data';

const meta = {
  title: 'Flows/WeldFlow/Plan a project (kanban)',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Open a project and plan its work on a kanban board. Drag task cards between ' +
          'Backlog / In Progress / Review / Done — the board is the real `@weldsuite/ui` ' +
          'kanban with drag-and-drop. Mock data only.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const STATUS_VARIANT: Record<ProjectStatus, React.ComponentProps<typeof Badge>['variant']> = {
  planning: 'secondary',
  active: 'default',
  on_hold: 'outline',
  done: 'secondary',
};

const projectColumns: ListTableColumn<Project>[] = [
  {
    id: 'name',
    header: 'Project',
    cell: (row) => <span className="text-sm font-medium">{row.name}</span>,
  },
  {
    id: 'status',
    header: 'Status',
    width: 'w-[120px]',
    cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{PROJECT_STATUS_LABELS[row.status]}</Badge>,
  },
  {
    id: 'progress',
    header: 'Progress',
    width: 'w-[180px]',
    cell: (row) => (
      <div className="flex w-full items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${row.progress}%` }} />
        </div>
        <span className="w-9 text-right text-xs text-muted-foreground">{row.progress}%</span>
      </div>
    ),
  },
  {
    id: 'tasks',
    header: 'Tasks',
    width: 'w-[70px]',
    align: 'right',
    accessor: (row) => <span className="text-sm text-muted-foreground">{row.taskCount}</span>,
  },
  {
    id: 'due',
    header: 'Due',
    width: 'w-[120px]',
    accessor: (row) => <span className="text-sm text-muted-foreground">{shortDate(row.dueDate)}</span>,
  },
  {
    id: 'lead',
    header: 'Lead',
    width: 'w-[110px]',
    accessor: (row) => <span className="text-sm">{row.lead}</span>,
  },
];

export const Flow: Story = {
  render: () => {
    const [tasks, setTasks] = React.useState<Task[]>(websiteTasks);

    const steps: FlowStep[] = [
      {
        title: 'Projects',
        description: 'Pick a project to plan. Open "Website redesign".',
        render: ({ goNext }) => (
          <AppFrame module="WeldFlow" breadcrumb={['Projects']}>
            <div className="flex h-full flex-col">
              <ListToolbar
                searchPlaceholder="Search projects…"
                createButton={{ label: 'New project', onClick: () => {} }}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                <ListTable
                  columns={projectColumns}
                  data={projects}
                  rowKey={(r) => r.id}
                  onRowClick={(r) => r.id === 'prj_website' && goNext()}
                />
              </div>
            </div>
          </AppFrame>
        ),
      },
      {
        title: 'Board',
        description: 'Drag cards between columns to plan the work.',
        render: () => (
          <AppFrame module="WeldFlow" breadcrumb={['Projects', 'Website redesign', 'Board']}>
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm text-muted-foreground">
                <MoveHorizontal className="h-4 w-4" />
                Drag a card to a different column — the board updates live.
              </div>
              <div className="min-h-0 flex-1">
                <TaskBoard columns={taskStages} data={tasks} onDataChange={setTasks} />
              </div>
            </div>
          </AppFrame>
        ),
      },
    ];

    return (
      <div className="h-screen w-screen">
        <FlowStepper title="Plan a project (kanban)" steps={steps} />
      </div>
    );
  },
};
