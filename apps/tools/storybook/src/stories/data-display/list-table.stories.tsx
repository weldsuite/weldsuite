import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import {
  PhoneIncoming,
  PhoneOutgoing,
  FileText,
  Link2,
  Play,
  Trash2,
  Edit,
  Mail,
} from 'lucide-react';
import { format } from 'date-fns';

import {
  ListTable,
  type ListTableColumn,
  type ListTableAction,
  type ListTableGroup,
} from '@weldsuite/ui/components/list-table';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@weldsuite/ui/lib/utils';

const meta: Meta<typeof ListTable> = {
  title: 'Data Display/List Table',
  component: ListTable,
  parameters: { layout: 'padded' },
};

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Story 1: Call records (the original call-intelligence use case)
// ---------------------------------------------------------------------------

interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound';
  status: 'completed' | 'answered' | 'no_answer' | 'failed' | 'busy' | 'ringing' | 'canceled';
  fromNumber: string;
  toNumber: string;
  duration: number;
  isRecorded: boolean;
  initiatedAt: string;
}

const sampleCalls: CallRow[] = [
  { id: 'c1', direction: 'inbound', status: 'completed', fromNumber: '+31612345678', toNumber: '+31205550100', duration: 482, isRecorded: true, initiatedAt: '2026-04-18T09:12:00Z' },
  { id: 'c2', direction: 'outbound', status: 'answered', fromNumber: '+31205550100', toNumber: '+4915112345678', duration: 3725, isRecorded: true, initiatedAt: '2026-04-18T10:02:00Z' },
  { id: 'c3', direction: 'outbound', status: 'no_answer', fromNumber: '+31205550100', toNumber: '+447123456789', duration: 0, isRecorded: false, initiatedAt: '2026-04-18T11:30:00Z' },
  { id: 'c4', direction: 'inbound', status: 'failed', fromNumber: '+12025550142', toNumber: '+31205550100', duration: 0, isRecorded: false, initiatedAt: '2026-04-18T12:45:00Z' },
  { id: 'c5', direction: 'inbound', status: 'busy', fromNumber: '+33612345678', toNumber: '+31205550100', duration: 0, isRecorded: false, initiatedAt: '2026-04-18T13:20:00Z' },
  { id: 'c6', direction: 'outbound', status: 'ringing', fromNumber: '+31205550100', toNumber: '+32476123456', duration: 12, isRecorded: false, initiatedAt: '2026-04-18T14:05:00Z' },
];

function formatDuration(sec: number) {
  if (!sec) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

const callStatusColor: Record<string, string> = {
  completed: 'bg-gray-100 text-gray-800 dark:bg-background/30 dark:text-muted-foreground',
  answered: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  ringing: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  no_answer: 'bg-gray-100 text-gray-600 dark:bg-secondary dark:text-muted-foreground',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  busy: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  canceled: 'bg-gray-100 text-gray-500 dark:bg-secondary dark:text-muted-foreground',
};

const callColumns: ListTableColumn<CallRow>[] = [
  {
    id: 'direction',
    header: 'Direction',
    width: 140,
    cell: (c) => (
      <div className="flex items-center gap-2">
        {c.direction === 'inbound' ? (
          <PhoneIncoming className="h-4 w-4 text-green-600" />
        ) : (
          <PhoneOutgoing className="h-4 w-4 text-blue-600" />
        )}
        <span className="text-sm capitalize">{c.direction}</span>
      </div>
    ),
  },
  {
    id: 'from',
    header: 'From',
    width: 180,
    cell: (c) => <span className="font-mono text-sm">{c.fromNumber}</span>,
  },
  {
    id: 'to',
    header: 'To',
    cell: (c) => <span className="font-mono text-sm">{c.toNumber}</span>,
  },
  {
    id: 'duration',
    header: 'Duration',
    width: 120,
    cell: (c) => <span className="text-sm font-mono text-muted-foreground">{formatDuration(c.duration)}</span>,
  },
  {
    id: 'recording',
    header: 'Recording',
    width: 110,
    cell: (c) =>
      c.isRecorded ? (
        <Badge className="text-xs font-medium rounded-md border-transparent bg-red-100 text-red-700">Recorded</Badge>
      ) : (
        <Badge className="text-xs font-medium rounded-md border-transparent bg-gray-100 text-gray-500">No</Badge>
      ),
  },
  {
    id: 'status',
    header: 'Status',
    width: 130,
    cell: (c) => (
      <Badge className={cn('text-xs font-medium rounded-md border-transparent', callStatusColor[c.status])}>
        {c.status.replace('_', ' ')}
      </Badge>
    ),
  },
  {
    id: 'date',
    header: 'Date',
    width: 180,
    cell: (c) => (
      <span className="text-sm font-mono text-muted-foreground">
        {format(new Date(c.initiatedAt), 'yyyy-MM-dd HH:mm')}
      </span>
    ),
  },
];

const callActions: ListTableAction<CallRow>[] = [
  { id: 'view', label: 'View Details', icon: FileText, onClick: fn() },
  { id: 'play', label: 'Play Recording', icon: Play, onClick: fn(), hidden: (c) => !c.isRecorded },
  { id: 'link', label: 'Link to CRM', icon: Link2, onClick: fn() },
  { id: 'delete', label: 'Delete', icon: Trash2, onClick: fn(), separatorAbove: true, variant: 'destructive' },
];

export const Calls: Story = {
  args: {
    columns: callColumns as ListTableColumn<unknown>[],
    data: sampleCalls as unknown[],
    actions: callActions as ListTableAction<unknown>[],
    onRowClick: fn(),
  },
};

// ---------------------------------------------------------------------------
// Story 2: Invoice records — proves genericness with different data shape
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  contactName: string;
  dueDate: string;
  total: number;
  currency: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue';
}

const sampleInvoices: InvoiceRow[] = [
  { id: 'i1', invoiceNumber: 'INV-0001', contactName: 'Acme Widgets BV', dueDate: '2026-05-01', total: 1815, currency: 'EUR', status: 'sent' },
  { id: 'i2', invoiceNumber: 'INV-0002', contactName: 'Jane Doe Freelance', dueDate: '2026-04-22', total: 605, currency: 'EUR', status: 'paid' },
  { id: 'i3', invoiceNumber: 'INV-0003', contactName: 'Globex Inc', dueDate: '2026-04-10', total: 9999, currency: 'USD', status: 'overdue' },
  { id: 'i4', invoiceNumber: 'INV-0004', contactName: 'Soylent GmbH', dueDate: '2026-05-15', total: 250, currency: 'EUR', status: 'draft' },
];

const invoiceStatusColor: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  sent: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
};

export const Invoices: Story = {
  args: {
    columns: [
      { id: 'number', header: 'Invoice', width: 120, accessor: (r: InvoiceRow) => r.invoiceNumber },
      { id: 'contact', header: 'Contact', accessor: (r: InvoiceRow) => r.contactName },
      { id: 'due', header: 'Due', width: 140, accessor: (r: InvoiceRow) => r.dueDate },
      {
        id: 'total',
        header: 'Total',
        width: 130,
        align: 'right',
        cell: (r: InvoiceRow) => (
          <span className="tabular-nums font-medium">
            {new Intl.NumberFormat('nl-NL', { style: 'currency', currency: r.currency }).format(r.total)}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        width: 110,
        cell: (r: InvoiceRow) => (
          <Badge className={cn('text-xs font-medium rounded-md border-transparent', invoiceStatusColor[r.status])}>
            {r.status}
          </Badge>
        ),
      },
    ] as ListTableColumn<unknown>[],
    data: sampleInvoices as unknown[],
    actions: [
      { id: 'view', label: 'View', icon: FileText, onClick: fn() },
      { id: 'email', label: 'Email to contact', icon: Mail, onClick: fn() },
      { id: 'edit', label: 'Edit', icon: Edit, onClick: fn() },
      { id: 'delete', label: 'Delete', icon: Trash2, onClick: fn(), separatorAbove: true, variant: 'destructive' },
    ] as ListTableAction<unknown>[],
    onRowClick: fn(),
  },
};

// ---------------------------------------------------------------------------
// Story 3: Empty state
// ---------------------------------------------------------------------------

export const Empty: Story = {
  args: {
    columns: callColumns as ListTableColumn<unknown>[],
    data: [],
    emptyMessage: 'No calls yet — make your first call to see activity here.',
  },
};

// ---------------------------------------------------------------------------
// Story 4: Without actions column
// ---------------------------------------------------------------------------

export const WithoutActions: Story = {
  args: {
    columns: callColumns as ListTableColumn<unknown>[],
    data: sampleCalls as unknown[],
    onRowClick: fn(),
  },
};

// ---------------------------------------------------------------------------
// Story 5: Dense rows
// ---------------------------------------------------------------------------

export const Dense: Story = {
  args: {
    columns: callColumns as ListTableColumn<unknown>[],
    data: sampleCalls as unknown[],
    actions: callActions as ListTableAction<unknown>[],
    dense: true,
  },
};

// ---------------------------------------------------------------------------
// Story 6: Grouped — time-bucketed calls (Today / Yesterday / This Week / Older)
// ---------------------------------------------------------------------------

// Anchor dates to the existing fixture data so the buckets are visually
// non-empty regardless of when Storybook is opened.
const groupedCallsFixture: CallRow[] = [
  // "Today" bucket
  { id: 'g1', direction: 'inbound', status: 'completed', fromNumber: '+31612345678', toNumber: '+31205550100', duration: 482, isRecorded: true, initiatedAt: new Date().toISOString() },
  { id: 'g2', direction: 'outbound', status: 'answered', fromNumber: '+31205550100', toNumber: '+4915112345678', duration: 245, isRecorded: false, initiatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
  // "Yesterday" bucket
  { id: 'g3', direction: 'outbound', status: 'no_answer', fromNumber: '+31205550100', toNumber: '+447123456789', duration: 0, isRecorded: false, initiatedAt: new Date(Date.now() - 28 * 60 * 60 * 1000).toISOString() },
  { id: 'g4', direction: 'inbound', status: 'failed', fromNumber: '+12025550142', toNumber: '+31205550100', duration: 0, isRecorded: false, initiatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() },
  // "This Week" bucket
  { id: 'g5', direction: 'inbound', status: 'busy', fromNumber: '+33612345678', toNumber: '+31205550100', duration: 0, isRecorded: false, initiatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
  { id: 'g6', direction: 'outbound', status: 'ringing', fromNumber: '+31205550100', toNumber: '+32476123456', duration: 12, isRecorded: false, initiatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
  // "Older" bucket
  { id: 'g7', direction: 'outbound', status: 'canceled', fromNumber: '+31205550100', toNumber: '+493012345678', duration: 3, isRecorded: false, initiatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() },
  { id: 'g8', direction: 'inbound', status: 'completed', fromNumber: '+31655667788', toNumber: '+31205550100', duration: 1822, isRecorded: true, initiatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() },
];

function buildCallTimeGroups(): ListTableGroup<CallRow>[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  const startOfWeek = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);

  const callDate = (c: CallRow) => (c.initiatedAt ? new Date(c.initiatedAt) : null);

  return [
    {
      id: 'today',
      label: 'Today',
      sortOrder: 1,
      filter: (c) => {
        const d = callDate(c);
        return d ? d >= startOfToday : false;
      },
    },
    {
      id: 'yesterday',
      label: 'Yesterday',
      sortOrder: 2,
      filter: (c) => {
        const d = callDate(c);
        return d ? d >= startOfYesterday && d < startOfToday : false;
      },
    },
    {
      id: 'this-week',
      label: 'This Week',
      sortOrder: 3,
      filter: (c) => {
        const d = callDate(c);
        return d ? d >= startOfWeek && d < startOfYesterday : false;
      },
    },
    {
      id: 'older',
      label: 'Older',
      sortOrder: 4,
      filter: (c) => {
        const d = callDate(c);
        return d ? d < startOfWeek : !c.initiatedAt;
      },
    },
  ];
}

export const Grouped: Story = {
  args: {
    columns: callColumns as ListTableColumn<unknown>[],
    data: groupedCallsFixture as unknown[],
    actions: callActions as ListTableAction<unknown>[],
    onRowClick: fn(),
    groups: buildCallTimeGroups() as unknown as ListTableGroup<unknown>[],
  },
};

// ---------------------------------------------------------------------------
// Story 7: Grouped by status — shows a different grouping dimension
// ---------------------------------------------------------------------------

export const GroupedByStatus: Story = {
  args: {
    columns: callColumns as ListTableColumn<unknown>[],
    data: sampleCalls as unknown[],
    actions: callActions as ListTableAction<unknown>[],
    onRowClick: fn(),
    groups: [
      { id: 'completed', label: 'Completed', filter: (c: CallRow) => c.status === 'completed' || c.status === 'answered', sortOrder: 1 },
      { id: 'missed', label: 'Missed', filter: (c: CallRow) => c.status === 'no_answer' || c.status === 'busy' || c.status === 'failed', sortOrder: 2 },
      { id: 'active', label: 'Active', filter: (c: CallRow) => c.status === 'ringing', sortOrder: 3 },
      { id: 'canceled', label: 'Canceled', filter: (c: CallRow) => c.status === 'canceled', sortOrder: 4 },
    ] as unknown as ListTableGroup<unknown>[],
  },
};
