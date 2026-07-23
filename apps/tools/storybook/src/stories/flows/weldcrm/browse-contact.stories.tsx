import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Building2, Mail, MapPin, Pencil, Phone, Tag } from 'lucide-react';

import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { EntityInfoCard } from '@weldsuite/ui/components/entity-info-card';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { ListToolbar, type ActiveFilter, type FilterConfig } from '@weldsuite/ui/components/list-toolbar';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { cn } from '@weldsuite/ui/lib/utils';

import { AppFrame } from '../../../flows/app-frame';
import { FlowStepper, type FlowStep } from '../../../flows/flow-stepper';
import { ActivityTimeline, PersonChip, SectionTitle, shortDate } from '../../../flows/bits';
import {
  contactActivity,
  people,
  STATUS_LABELS,
  type Person,
  type PersonStatus,
} from '../../../mocks/data';

const meta = {
  title: 'Flows/WeldCRM/Browse & edit a contact',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Search and filter the contacts list, open a contact in the detail pane, then ' +
          'inline-edit a field and see it persist. Master-detail layout, search, filter ' +
          'pills and the info card are the same components the platform ships. Mock data only.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/* ------------------------------- helpers ------------------------------- */

const STATUS_DOT: Record<PersonStatus, string> = {
  customer: 'bg-emerald-500',
  active: 'bg-blue-500',
  lead: 'bg-amber-500',
  inactive: 'bg-muted-foreground/40',
};

const statusFilterConfig: FilterConfig = {
  field: 'status',
  label: 'Status',
  filterType: 'select',
  options: (Object.keys(STATUS_LABELS) as PersonStatus[]).map((s) => ({
    value: s,
    label: STATUS_LABELS[s],
  })),
};

function ContactRow({
  person,
  selected,
  onClick,
}: {
  person: Person;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50',
        selected && 'bg-muted',
      )}
    >
      <PersonChip initials={person.initials} name={person.name} subtitle={person.email} />
      <span
        className={cn('ml-auto h-2 w-2 flex-shrink-0 rounded-full', STATUS_DOT[person.status])}
        title={STATUS_LABELS[person.status]}
      />
    </button>
  );
}

/* -------------------------------- flow --------------------------------- */

export const Flow: Story = {
  render: () => {
    const [rows, setRows] = React.useState<Person[]>(people);
    const [search, setSearch] = React.useState('');
    const [filters, setFilters] = React.useState<ActiveFilter[]>([]);
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [draftTitle, setDraftTitle] = React.useState('');

    const selected = rows.find((p) => p.id === selectedId) ?? null;

    const statusValues = filters.filter((f) => f.field === 'status').map((f) => f.value);
    const visible = rows.filter((p) => {
      const q = search.trim().toLowerCase();
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        p.company.toLowerCase().includes(q);
      const matchesStatus = statusValues.length === 0 || statusValues.includes(p.status);
      return matchesSearch && matchesStatus;
    });

    const listPane = (onSelect: (p: Person) => void) => (
      <div className="flex h-full flex-col">
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search people…"
          filterConfigs={[statusFilterConfig]}
          filters={filters}
          onFiltersChange={setFilters}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No contacts match.</p>
          ) : (
            visible.map((p) => (
              <ContactRow
                key={p.id}
                person={p}
                selected={p.id === selectedId}
                onClick={() => onSelect(p)}
              />
            ))
          )}
        </div>
      </div>
    );

    const detailPane = (mode: 'read' | 'edit') => {
      if (!selected) {
        return (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            Select a contact to see their details
          </div>
        );
      }
      return (
        <div className="flex h-full w-full flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <PersonChip
              initials={selected.initials}
              name={selected.name}
              subtitle={`${selected.jobTitle} • ${selected.company}`}
              size="lg"
            />
            <Badge variant={selected.status === 'customer' ? 'default' : 'secondary'}>
              {STATUS_LABELS[selected.status]}
            </Badge>
          </div>
          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="h-10 bg-transparent px-4">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
            </TabsList>
          </Tabs>
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
            <div className="space-y-5">
              <EntityInfoCard
                title="Details"
                items={[
                  { icon: Mail, label: 'Email', value: selected.email },
                  { icon: Phone, label: 'Phone', value: selected.phone || '—' },
                  { icon: Building2, label: 'Company', value: selected.company },
                  { icon: MapPin, label: 'City', value: selected.city || '—' },
                ]}
              />
              {/* Editable job title field */}
              <div>
                <div className="flex items-center justify-between">
                  <SectionTitle>Job title</SectionTitle>
                  {mode === 'read' ? null : (
                    <span className="text-xs text-primary">Editing</span>
                  )}
                </div>
                {mode === 'read' ? (
                  <p className="mt-2 text-sm font-medium">{selected.jobTitle}</p>
                ) : (
                  <input
                    autoFocus
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                )}
              </div>
              {selected.tags.length > 0 ? (
                <div>
                  <SectionTitle>Tags</SectionTitle>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selected.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        <Tag className="h-3 w-3" />
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      );
    };

    const steps: FlowStep[] = [
      {
        title: 'Browse',
        description: 'Search or filter, then open a contact.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['People']}>
            <ListDetailLayout
              isDetailSelected={false}
              list={listPane((p) => {
                setSelectedId(p.id);
                setDraftTitle(p.jobTitle);
                goNext();
              })}
            >
              {detailPane('read')}
            </ListDetailLayout>
          </AppFrame>
        ),
      },
      {
        title: 'Open',
        description: 'The contact opens in the detail pane. Edit a field.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['People', selected?.name ?? '']}>
            <ListDetailLayout
              isDetailSelected
              list={listPane((p) => {
                setSelectedId(p.id);
                setDraftTitle(p.jobTitle);
              })}
            >
              <div className="relative h-full w-full">
                {detailPane('read')}
                <div className="absolute right-6 top-4">
                  <Button variant="outline" size="sm" onClick={goNext}>
                    <Pencil className="mr-1.5 h-4 w-4" />
                    Edit
                  </Button>
                </div>
              </div>
            </ListDetailLayout>
          </AppFrame>
        ),
      },
      {
        title: 'Edit',
        description: 'Change the job title and save.',
        render: ({ goNext }) => (
          <AppFrame module="WeldCRM" breadcrumb={['People', selected?.name ?? '', 'Edit']}>
            <ListDetailLayout isDetailSelected list={listPane((p) => setSelectedId(p.id))}>
              <div className="relative h-full w-full">
                {detailPane('edit')}
                <div className="absolute right-6 top-4 flex gap-2">
                  <Button variant="outline" size="sm" onClick={goNext}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setRows((prev) =>
                        prev.map((p) =>
                          p.id === selectedId ? { ...p, jobTitle: draftTitle } : p,
                        ),
                      );
                      goNext();
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </ListDetailLayout>
          </AppFrame>
        ),
      },
      {
        title: 'Saved',
        description: 'The change is reflected on the contact.',
        render: () => (
          <AppFrame module="WeldCRM" breadcrumb={['People', selected?.name ?? '']}>
            <ListDetailLayout isDetailSelected list={listPane((p) => setSelectedId(p.id))}>
              <div className="relative h-full w-full">
                <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-6 py-2.5 text-sm">
                  <Badge variant="default">Saved</Badge>
                  <span className="text-muted-foreground">Job title updated.</span>
                </div>
                {detailPane('read')}
              </div>
            </ListDetailLayout>
          </AppFrame>
        ),
      },
    ];

    return (
      <div className="h-screen w-screen">
        <FlowStepper title="Browse & edit a contact" steps={steps} />
      </div>
    );
  },
};
