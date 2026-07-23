import { useState, useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { Settings, PhoneCall } from 'lucide-react';

import {
  ListToolbar,
  type ActiveFilter,
  type FilterConfig,
} from '@weldsuite/ui/components/list-toolbar';
import { Button } from '@weldsuite/ui/components/button';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { Badge } from '@weldsuite/ui/components/badge';

const meta: Meta<typeof ListToolbar> = {
  title: 'Data Display/List Toolbar',
  component: ListToolbar,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Fixture: call records for a realistic demo
// ---------------------------------------------------------------------------

interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound';
  status: 'completed' | 'answered' | 'no_answer' | 'failed' | 'busy';
  from: string;
  to: string;
  durationSec: number;
  isRecorded: boolean;
}

const sampleCalls: CallRow[] = [
  { id: 'c1', direction: 'inbound', status: 'completed', from: '+31612345678', to: '+31205550100', durationSec: 482, isRecorded: true },
  { id: 'c2', direction: 'outbound', status: 'answered', from: '+31205550100', to: '+4915112345678', durationSec: 3725, isRecorded: true },
  { id: 'c3', direction: 'outbound', status: 'no_answer', from: '+31205550100', to: '+447123456789', durationSec: 0, isRecorded: false },
  { id: 'c4', direction: 'inbound', status: 'failed', from: '+12025550142', to: '+31205550100', durationSec: 0, isRecorded: false },
  { id: 'c5', direction: 'inbound', status: 'busy', from: '+33612345678', to: '+31205550100', durationSec: 0, isRecorded: false },
];

const filterConfigs: FilterConfig[] = [
  {
    field: 'direction',
    label: 'Direction',
    options: [
      { value: 'inbound', label: 'Inbound' },
      { value: 'outbound', label: 'Outbound' },
    ],
  },
  {
    field: 'status',
    label: 'Status',
    options: [
      { value: 'completed', label: 'Completed' },
      { value: 'answered', label: 'Connected' },
      { value: 'no_answer', label: 'No Answer' },
      { value: 'failed', label: 'Failed' },
      { value: 'busy', label: 'Busy' },
    ],
  },
  {
    field: 'recording',
    label: 'Recording',
    filterType: 'boolean',
    options: [],
  },
];

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Default: Story = {
  render: () => {
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<ActiveFilter[]>([]);
    return (
      <div className="border rounded-md">
        <ListToolbar
          filterConfigs={filterConfigs}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search calls..."
          createButton={{ label: 'New Call', onClick: fn() }}
        />
      </div>
    );
  },
};

export const WithLeftAndRightActionButtons: Story = {
  render: () => {
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<ActiveFilter[]>([]);
    return (
      <div className="border rounded-md">
        <ListToolbar
          filterConfigs={filterConfigs}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search calls..."
          leftActionButtons={
            <Button variant="outline" size="sm" className="h-8 shadow-none">
              <PhoneCall className="h-4 w-4 mr-1" />
              Missed only
            </Button>
          }
          actionButtons={
            <Button variant="outline" size="sm" className="h-8 shadow-none text-muted-foreground">
              <Settings className="h-3.5 w-3.5 mr-1" />
              Phone Settings
            </Button>
          }
          createButton={{ label: 'Make Call', onClick: fn() }}
        />
      </div>
    );
  },
};

export const WithPreAppliedFilters: Story = {
  render: () => {
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<ActiveFilter[]>([
      { id: 'f1', field: 'direction', operator: 'is', value: 'inbound' },
      { id: 'f2', field: 'status', operator: 'is not', value: 'failed' },
    ]);
    return (
      <div className="border rounded-md">
        <ListToolbar
          filterConfigs={filterConfigs}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search calls..."
          createButton={{ label: 'New Call', onClick: fn() }}
        />
      </div>
    );
  },
};

export const SearchOnlyNoFilters: Story = {
  render: () => {
    const [search, setSearch] = useState('');
    return (
      <div className="border rounded-md">
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search…"
          createButton={{ label: 'New', onClick: fn() }}
        />
      </div>
    );
  },
};

export const NoCreateButton: Story = {
  render: () => {
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<ActiveFilter[]>([]);
    return (
      <div className="border rounded-md">
        <ListToolbar
          filterConfigs={filterConfigs}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search..."
        />
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// End-to-end: toolbar + ListTable wired together
// ---------------------------------------------------------------------------

export const WithListTable: Story = {
  render: () => {
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<ActiveFilter[]>([]);

    const filtered = useMemo(() => {
      let rows = sampleCalls;

      if (search.trim()) {
        const q = search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.from.toLowerCase().includes(q) ||
            r.to.toLowerCase().includes(q) ||
            r.status.includes(q),
        );
      }

      for (const f of filters) {
        if (!f.operator || !f.value) continue;
        if (f.field === 'direction') {
          rows = f.operator === 'is'
            ? rows.filter((r) => r.direction === f.value)
            : rows.filter((r) => r.direction !== f.value);
        } else if (f.field === 'status') {
          rows = f.operator === 'is'
            ? rows.filter((r) => r.status === f.value)
            : rows.filter((r) => r.status !== f.value);
        } else if (f.field === 'recording') {
          const want = f.value === 'true';
          rows = rows.filter((r) => r.isRecorded === want);
        }
      }

      return rows;
    }, [search, filters]);

    const columns: ListTableColumn<CallRow>[] = [
      { id: 'direction', header: 'Direction', width: 120, cell: (c) => <span className="capitalize">{c.direction}</span> },
      { id: 'from', header: 'From', width: 180, accessor: (c) => c.from },
      { id: 'to', header: 'To', accessor: (c) => c.to },
      {
        id: 'duration',
        header: 'Duration',
        width: 120,
        cell: (c) => `${Math.floor(c.durationSec / 60)}m ${c.durationSec % 60}s`,
      },
      {
        id: 'status',
        header: 'Status',
        width: 130,
        cell: (c) => <Badge className="capitalize">{c.status.replace('_', ' ')}</Badge>,
      },
    ];

    return (
      <div className="border rounded-md">
        <ListToolbar
          filterConfigs={filterConfigs}
          filters={filters}
          onFiltersChange={setFilters}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search calls..."
          createButton={{ label: 'New Call', onClick: fn() }}
        />
        <ListTable<CallRow>
          columns={columns}
          data={filtered}
          onRowClick={fn()}
          emptyMessage="No calls match the current filters."
        />
      </div>
    );
  },
};
