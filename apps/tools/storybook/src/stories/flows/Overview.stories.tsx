import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Briefcase, Users } from 'lucide-react';

import { Badge } from '@weldsuite/ui/components/badge';
import { Card } from '@weldsuite/ui/components/card';

const meta = {
  title: 'Flows/Overview',
  parameters: {
    layout: 'fullscreen',
    options: { showPanel: false },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

interface ModuleEntry {
  module: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
  flows: { name: string; what: string }[];
}

const MODULES: ModuleEntry[] = [
  {
    module: 'WeldCRM',
    icon: Users,
    blurb: 'Contacts, companies, leads and pipeline.',
    flows: [
      {
        name: 'Capture a lead → convert',
        what: 'Log an inbound lead, review it, and convert it into a contact.',
      },
      {
        name: 'Browse & edit a contact',
        what: 'Search/filter the contacts list, open the detail pane, inline-edit a field.',
      },
    ],
  },
  {
    module: 'WeldFlow',
    icon: Briefcase,
    blurb: 'Projects, tasks and kanban boards.',
    flows: [
      {
        name: 'Plan a project (kanban)',
        what: 'Open a project and drag task cards across Backlog / In Progress / Review / Done.',
      },
      { name: 'Create a task', what: 'Add a task via the quick-create form; it lands in Backlog.' },
    ],
  },
];

/**
 * Landing page for the Flows section. Each entry below is a clickable,
 * multi-step walk-through under `Flows/<Module>/…` in the sidebar.
 */
export const Index: Story = {
  render: () => (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">WeldSuite — User Flows</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Clickable, pre-filled walk-throughs of what the platform offers. Pick a flow from the
          sidebar under <span className="font-medium text-foreground">Flows</span> and step through
          it with the Back / Next controls. Everything runs on mock data — no backend, no sign-in,
          nothing to fill out. Screens are built from the same shared UI components the real
          platform ships.
        </p>
      </header>

      <div className="space-y-6">
        {MODULES.map(({ module, icon: Icon, blurb, flows }) => (
          <section key={module}>
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <h2 className="text-lg font-semibold">{module}</h2>
              <span className="text-sm text-muted-foreground">— {blurb}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {flows.map((flow) => (
                <Card key={flow.name} className="gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{module}</Badge>
                    <span className="text-sm font-medium">{flow.name}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{flow.what}</p>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  ),
};
