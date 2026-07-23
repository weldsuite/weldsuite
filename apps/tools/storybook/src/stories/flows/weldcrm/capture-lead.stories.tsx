import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';
import { ArrowRight, Building2, Calendar, Mail, Tag, UserPlus } from 'lucide-react';

import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { EntityInfoCard } from '@weldsuite/ui/components/entity-info-card';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';

import { AppFrame } from '../../../flows/app-frame';
import { FlowStepper, type FlowStep } from '../../../flows/flow-stepper';
import {
  ActivityTimeline,
  FormField,
  PersonChip,
  SectionTitle,
  shortDate,
} from '../../../flows/bits';
import {
  contactActivity,
  LEAD_STAGE_LABELS,
  leads,
  newLead,
  type Lead,
  type LeadStage,
  type Person,
} from '../../../mocks/data';

const meta = {
  title: 'Flows/WeldCRM/Capture a lead → convert',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'A guided walk-through of capturing an inbound lead and converting it into a ' +
          'contact. Step through with Back / Next — the leads list and people list update ' +
          'as you go. All data is mocked; no backend is involved.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------- helpers ------------------------------- */

const STAGE_VARIANT: Record<LeadStage, React.ComponentProps<typeof Badge>['variant']> = {
  new: 'secondary',
  contacted: 'outline',
  qualified: 'default',
  unqualified: 'destructive',
};

function StageBadge({ stage }: { stage: LeadStage }) {
  return <Badge variant={STAGE_VARIANT[stage]}>{LEAD_STAGE_LABELS[stage]}</Badge>;
}

function leadColumns(highlightId?: string): ListTableColumn<Lead>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <PersonChip initials={row.initials} name={row.name} subtitle={row.companyName} />
          {row.id === highlightId ? (
            <Badge variant="default" className="ml-1">
              New
            </Badge>
          ) : null}
        </div>
      ),
    },
    { id: 'stage', header: 'Stage', width: 'w-[120px]', cell: (row) => <StageBadge stage={row.stage} /> },
    {
      id: 'source',
      header: 'Source',
      width: 'w-[150px]',
      accessor: (row) => <span className="text-sm text-muted-foreground">{row.source}</span>,
    },
    {
      id: 'value',
      header: 'Est. value',
      width: 'w-[110px]',
      align: 'right',
      accessor: (row) => <span className="text-sm">€{row.estimatedValue.toLocaleString()}</span>,
    },
    {
      id: 'created',
      header: 'Created',
      width: 'w-[120px]',
      accessor: (row) => (
        <span className="text-sm text-muted-foreground">{shortDate(row.createdAt)}</span>
      ),
    },
  ];
}

function leadToPerson(lead: Lead): Person {
  return {
    id: `per_from_${lead.id}`,
    firstName: lead.firstName,
    lastName: lead.lastName,
    name: lead.name,
    initials: lead.initials,
    email: lead.email,
    phone: '',
    jobTitle: 'Buyer',
    company: lead.companyName,
    status: 'active',
    tags: ['Converted'],
    city: '',
    createdAt: new Date().toISOString(),
  };
}

/* -------------------------------- flow --------------------------------- */

export const Flow: Story = {
  render: () => {
    const [leadRows, setLeadRows] = React.useState<Lead[]>(leads);
    const [peopleRows, setPeopleRows] = React.useState<Person[]>([]);
    const converted = peopleRows.length > 0;

    const steps: FlowStep[] = [
      {
        title: 'Leads',
        description: 'Your current leads. A new one just arrived from the website form.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['Leads']}>
            <div className="flex h-full flex-col">
              <ListToolbar
                searchPlaceholder="Search leads…"
                createButton={{ label: 'New lead', onClick: goNext }}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                <ListTable columns={leadColumns()} data={leadRows} rowKey={(r) => r.id} />
              </div>
            </div>
          </AppFrame>
        ),
      },
      {
        title: 'New lead',
        description: 'Capture the inbound enquiry.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['Leads', 'New lead']}>
            <div className="mx-auto max-w-xl p-6">
              <h2 className="mb-1 text-lg font-semibold">Create lead</h2>
              <p className="mb-5 text-sm text-muted-foreground">
                Pre-filled from the website enquiry form.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="First name" value={newLead.firstName} />
                <FormField label="Last name" value={newLead.lastName} />
                <FormField label="Email" value={newLead.email} />
                <FormField label="Company" value={newLead.companyName} />
                <FormField label="Source" value={newLead.source} />
                <FormField label="Estimated value" value={`€${newLead.estimatedValue.toLocaleString()}`} />
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="outline">Cancel</Button>
                <Button
                  onClick={() => {
                    setLeadRows([newLead, ...leads]);
                    goNext();
                  }}
                >
                  <UserPlus className="mr-1.5 h-4 w-4" />
                  Save lead
                </Button>
              </div>
            </div>
          </AppFrame>
        ),
      },
      {
        title: 'In the list',
        description: 'The new lead now sits at the top of the list. Open it.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['Leads']}>
            <div className="flex h-full flex-col">
              <ListToolbar
                searchPlaceholder="Search leads…"
                createButton={{ label: 'New lead', onClick: () => {} }}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                <ListTable
                  columns={leadColumns(newLead.id)}
                  data={leadRows}
                  rowKey={(r) => r.id}
                  onRowClick={(r) => r.id === newLead.id && goNext()}
                />
              </div>
            </div>
          </AppFrame>
        ),
      },
      {
        title: 'Lead detail',
        description: 'Review the lead, then convert it into a contact.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['Leads', newLead.name]}>
            <div className="flex h-full flex-col">
              {/* Detail header */}
              <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
                <PersonChip
                  initials={newLead.initials}
                  name={newLead.name}
                  subtitle={`Lead • ${newLead.companyName}`}
                  size="lg"
                />
                <div className="flex items-center gap-2">
                  <StageBadge stage={newLead.stage} />
                  <Button
                    onClick={() => {
                      setPeopleRows([leadToPerson(newLead)]);
                      goNext();
                    }}
                  >
                    Convert to contact
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </div>
              </div>
              <Tabs defaultValue="overview" className="w-full">
                <TabsList className="h-10 bg-transparent px-4">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="emails">Emails</TabsTrigger>
                </TabsList>
              </Tabs>
              {/* Body */}
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-8 overflow-auto p-6 lg:grid-cols-[1fr_320px]">
                <div>
                  <SectionTitle>Recent activity</SectionTitle>
                  <div className="mt-4">
                    <ActivityTimeline
                      items={contactActivity.map((a) => ({
                        id: a.id,
                        title: a.title,
                        body: a.body,
                        author: a.author,
                        when: shortDate(a.timestamp),
                      }))}
                    />
                  </div>
                </div>
                <EntityInfoCard
                  title="Details"
                  items={[
                    { icon: Mail, label: 'Email', value: newLead.email },
                    { icon: Building2, label: 'Company', value: newLead.companyName },
                    { icon: Tag, label: 'Source', value: newLead.source },
                    { icon: Calendar, label: 'Captured', value: shortDate(newLead.createdAt) },
                  ]}
                />
              </div>
            </div>
          </AppFrame>
        ),
      },
      {
        title: 'Contact created',
        description: 'The lead is now a contact in WeldCRM → People.',
        render: () => (
          <AppFrame module="WeldCRM" breadcrumb={['People']}>
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-4 py-2.5 text-sm">
                <Badge variant="default">Converted</Badge>
                <span className="text-muted-foreground">
                  {newLead.name} was converted from a lead into a contact.
                </span>
              </div>
              <ListToolbar
                searchPlaceholder="Search people…"
                createButton={{ label: 'New contact', onClick: () => {} }}
              />
              <div className="min-h-0 flex-1 overflow-auto">
                <ListTable
                  columns={[
                    {
                      id: 'name',
                      header: 'Name',
                      cell: (row: Person) => (
                        <div className="flex items-center gap-2">
                          <PersonChip initials={row.initials} name={row.name} subtitle={row.jobTitle} />
                          {converted && row.id.startsWith('per_from_') ? (
                            <Badge variant="default" className="ml-1">
                              New
                            </Badge>
                          ) : null}
                        </div>
                      ),
                    },
                    {
                      id: 'email',
                      header: 'Email',
                      width: 'w-[220px]',
                      accessor: (row: Person) => (
                        <span className="text-sm text-muted-foreground">{row.email}</span>
                      ),
                    },
                    {
                      id: 'company',
                      header: 'Company',
                      width: 'w-[200px]',
                      accessor: (row: Person) => <span className="text-sm">{row.company}</span>,
                    },
                  ]}
                  data={peopleRows}
                  rowKey={(r) => r.id}
                />
              </div>
            </div>
          </AppFrame>
        ),
      },
    ];

    return (
      <div className="h-screen w-screen">
        <FlowStepper title="Capture a lead → convert" steps={steps} />
      </div>
    );
  },
};

/**
 * Smoke test: drive the first few steps via the Next button and assert the new
 * lead appears in the list. Doubles as a demonstration of the interactions addon.
 */
export const FlowSmokeTest: Story = {
  ...Flow,
  tags: ['!autodocs'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Step 1 → 2: open the create form.
    await userEvent.click(canvas.getByRole('button', { name: 'New lead' }));
    expect(await canvas.findByText('Create lead')).toBeInTheDocument();

    // Step 2 → 3: save the lead; it should now be in the list.
    await userEvent.click(canvas.getByRole('button', { name: 'Save lead' }));
    expect(await canvas.findByText(newLead.companyName)).toBeInTheDocument();
  },
};
