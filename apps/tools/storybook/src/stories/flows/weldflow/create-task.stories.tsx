import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Plus } from 'lucide-react';

import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';

import { AppFrame } from '../../../flows/app-frame';
import { FlowStepper, type FlowStep } from '../../../flows/flow-stepper';
import { TaskBoard } from '../../../flows/task-board';
import { FormField } from '../../../flows/bits';
import { taskStages, websiteTasks, type Task } from '../../../mocks/data';

const meta = {
  title: 'Flows/WeldFlow/Create a task',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Add a new task to a project board. Fill the quick-create form and the card ' +
          'lands in the Backlog column. Mock data only.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NEW_TASK: Task = {
  id: 'tsk_new00001',
  name: 'Add cookie-consent banner',
  column: 'backlog',
  assignee: 'You',
  assigneeInitials: 'YO',
  priority: 'high',
  projectId: 'prj_website',
};

export const Flow: Story = {
  render: () => {
    const [tasks, setTasks] = React.useState<Task[]>(websiteTasks);

    const board = (banner?: React.ReactNode) => (
      <div className="flex h-full flex-col">
        {banner}
        <div className="min-h-0 flex-1">
          <TaskBoard columns={taskStages} data={tasks} onDataChange={setTasks} />
        </div>
      </div>
    );

    const steps: FlowStep[] = [
      {
        title: 'Board',
        description: 'The Website redesign board. Add a new task.',
        render: ({ goNext }) => (
          <AppFrame module="WeldFlow" breadcrumb={['Projects', 'Website redesign', 'Board']}>
            {board(
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="text-sm text-muted-foreground">{tasks.length} tasks</span>
                <Button size="sm" onClick={goNext}>
                  <Plus className="mr-1 h-4 w-4" />
                  New task
                </Button>
              </div>,
            )}
          </AppFrame>
        ),
      },
      {
        title: 'New task',
        description: 'Fill in the details and create.',
        render: ({ goNext }) => (
          <AppFrame
            module="WeldFlow"
            breadcrumb={['Projects', 'Website redesign', 'New task']}
          >
            <div className="mx-auto max-w-lg p-6">
              <h2 className="mb-1 text-lg font-semibold">New task</h2>
              <p className="mb-5 text-sm text-muted-foreground">In “Website redesign”.</p>
              <div className="space-y-4">
                <FormField label="Title" value={NEW_TASK.name} />
                <div className="grid grid-cols-2 gap-4">
                  <FormField label="Assignee" value={NEW_TASK.assignee} />
                  <FormField label="Stage" value="Backlog" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Priority</span>
                  <div>
                    <Badge variant="default">High</Badge>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="outline">Cancel</Button>
                <Button
                  onClick={() => {
                    setTasks((prev) =>
                      prev.some((t) => t.id === NEW_TASK.id) ? prev : [NEW_TASK, ...prev],
                    );
                    goNext();
                  }}
                >
                  Create task
                </Button>
              </div>
            </div>
          </AppFrame>
        ),
      },
      {
        title: 'On the board',
        description: 'The task is now in Backlog.',
        render: () => (
          <AppFrame module="WeldFlow" breadcrumb={['Projects', 'Website redesign', 'Board']}>
            {board(
              <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-4 py-2.5 text-sm">
                <Badge variant="default">Created</Badge>
                <span className="text-muted-foreground">
                  “{NEW_TASK.name}” was added to Backlog.
                </span>
              </div>,
            )}
          </AppFrame>
        ),
      },
    ];

    return (
      <div className="h-screen w-screen">
        <FlowStepper title="Create a task" steps={steps} />
      </div>
    );
  },
};
