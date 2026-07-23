import { useMemo } from 'react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import type { TranslationNamespaces } from '@/lib/i18n';
import {
  EntityGrid,
  type EntityGridConfig,
  type EntityGridActions,
  type GridPaginationState,
  type GridColumnDef,
  type StatusStyle,
} from '@/components/entity-grid';
import {
  User,
  Mail,
  Phone,
  Building,
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Clock,
  Calendar,
  Star,
} from 'lucide-react';
import { useCall } from '@/contexts/call-context';
import { WeldCallGate } from '../components/weldcall-gate';

interface CallContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company?: string;
  title?: string;
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  lastCallDate: string;
  totalMinutes: number;
  status: 'frequent' | 'regular' | 'occasional' | 'inactive';
  createdAt: string;
}

const sampleContacts: CallContact[] = [
  {
    id: 'c1',
    firstName: 'Sarah',
    lastName: 'Johnson',
    email: 'sarah.johnson@acme.com',
    phone: '+1 (555) 010-1100',
    company: 'Acme Corp',
    title: 'Product Manager',
    totalCalls: 32,
    inboundCalls: 18,
    outboundCalls: 14,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    totalMinutes: 480,
    status: 'frequent',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString(),
  },
  {
    id: 'c2',
    firstName: 'Mike',
    lastName: 'Chen',
    email: 'mike.chen@globex.io',
    phone: '+1 (555) 010-2200',
    company: 'Globex',
    title: 'Engineering Lead',
    totalCalls: 24,
    inboundCalls: 9,
    outboundCalls: 15,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    totalMinutes: 360,
    status: 'frequent',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 85).toISOString(),
  },
  {
    id: 'c3',
    firstName: 'Lisa',
    lastName: 'Park',
    email: 'lisa.park@initech.com',
    phone: '+1 (555) 010-3300',
    company: 'Initech',
    title: 'Designer',
    totalCalls: 18,
    inboundCalls: 12,
    outboundCalls: 6,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(),
    totalMinutes: 240,
    status: 'regular',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
  },
  {
    id: 'c4',
    firstName: 'Tom',
    lastName: 'Williams',
    email: 'tom.w@umbrella.co',
    phone: '+1 (555) 010-4400',
    company: 'Umbrella Inc',
    title: 'Sales Director',
    totalCalls: 14,
    inboundCalls: 5,
    outboundCalls: 9,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    totalMinutes: 210,
    status: 'regular',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 45).toISOString(),
  },
  {
    id: 'c5',
    firstName: 'Emma',
    lastName: 'Davis',
    email: 'emma.davis@stark.dev',
    phone: '+1 (555) 010-5500',
    company: 'Stark Dev',
    title: 'CTO',
    totalCalls: 11,
    inboundCalls: 6,
    outboundCalls: 5,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    totalMinutes: 165,
    status: 'regular',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString(),
  },
  {
    id: 'c6',
    firstName: 'James',
    lastName: 'Brown',
    email: 'james.brown@wayne.io',
    phone: '+1 (555) 010-6600',
    company: 'Wayne Enterprises',
    title: 'VP Engineering',
    totalCalls: 8,
    inboundCalls: 2,
    outboundCalls: 6,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    totalMinutes: 120,
    status: 'occasional',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
  },
  {
    id: 'c7',
    firstName: 'Nina',
    lastName: 'Patel',
    email: 'nina@patel.design',
    phone: '+1 (555) 010-7700',
    title: 'Freelance Designer',
    totalCalls: 6,
    inboundCalls: 3,
    outboundCalls: 3,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
    totalMinutes: 95,
    status: 'occasional',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 25).toISOString(),
  },
  {
    id: 'c8',
    firstName: 'Oscar',
    lastName: 'Lee',
    email: 'oscar.lee@oscorp.com',
    phone: '+1 (555) 010-8800',
    company: 'Oscorp',
    title: 'Backend Engineer',
    totalCalls: 4,
    inboundCalls: 1,
    outboundCalls: 3,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 168).toISOString(),
    totalMinutes: 60,
    status: 'occasional',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 20).toISOString(),
  },
  {
    id: 'c9',
    firstName: 'Rachel',
    lastName: 'Kim',
    email: 'rachel.kim@lexcorp.com',
    phone: '+1 (555) 010-9900',
    company: 'LexCorp',
    title: 'Project Manager',
    totalCalls: 3,
    inboundCalls: 1,
    outboundCalls: 2,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 200).toISOString(),
    totalMinutes: 45,
    status: 'inactive',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15).toISOString(),
  },
  {
    id: 'c10',
    firstName: 'Alex',
    lastName: 'Martinez',
    email: 'alex.m@daily.dev',
    phone: '+1 (555) 011-0010',
    company: 'Daily Dev',
    title: 'Developer',
    totalCalls: 2,
    inboundCalls: 0,
    outboundCalls: 2,
    lastCallDate: new Date(Date.now() - 1000 * 60 * 60 * 240).toISOString(),
    totalMinutes: 30,
    status: 'inactive',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
];

// Color/bg tokens only — labels are resolved via i18n inside the component
const callContactStatusColors: Record<string, { color: string; bg: string }> = {
  frequent: {
    color: 'text-emerald-700 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950',
  },
  regular: {
    color: 'text-blue-700 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950',
  },
  occasional: {
    color: 'text-amber-700 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950',
  },
  inactive: {
    color: 'text-gray-600 dark:text-muted-foreground',
    bg: 'bg-gray-100 dark:bg-secondary',
  },
};

function getContactName(contact: CallContact): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

function getContactInitials(contact: CallContact): string {
  return `${contact.firstName.charAt(0)}${contact.lastName.charAt(0)}`.toUpperCase();
}

function getContactSubtitle(contact: CallContact): string | undefined {
  const parts = [contact.title, contact.company].filter(Boolean);
  return parts.length > 0 ? parts.join(' • ') : undefined;
}

function formatTotalTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function buildCallContactColumns(tc: TranslationNamespaces['weldmeet']['weldcall']['contacts']): GridColumnDef<CallContact>[] {
  return [
    {
      id: 'name',
      name: tc.columns.name,
      type: 'company',
      width: 250,
      icon: User,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => getContactName(c),
    },
    {
      id: 'phone',
      name: tc.columns.phone,
      type: 'phone',
      width: 170,
      icon: Phone,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => c.phone,
    },
    {
      id: 'email',
      name: tc.columns.email,
      type: 'email',
      width: 220,
      icon: Mail,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => c.email,
    },
    {
      id: 'company',
      name: tc.columns.company,
      type: 'text',
      width: 160,
      icon: Building,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => c.company,
    },
    {
      id: 'title',
      name: tc.columns.jobTitle,
      type: 'text',
      width: 180,
      icon: Star,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => c.title,
    },
    {
      id: 'status',
      name: tc.columns.frequency,
      type: 'single-select',
      width: 130,
      icon: Star,
      visible: true,
      editable: false,
      sortable: true,
      options: ['frequent', 'regular', 'occasional', 'inactive'],
      selectConfig: {
        frequent: { label: tc.status.frequent, ...callContactStatusColors.frequent },
        regular: { label: tc.status.regular, ...callContactStatusColors.regular },
        occasional: { label: tc.status.occasional, ...callContactStatusColors.occasional },
        inactive: { label: tc.status.inactive, ...callContactStatusColors.inactive },
      },
      getValue: (c) => c.status,
    },
    {
      id: 'totalCalls',
      name: tc.columns.calls,
      type: 'number',
      width: 100,
      icon: PhoneCall,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => c.totalCalls,
    },
    {
      id: 'inboundCalls',
      name: tc.columns.inbound,
      type: 'number',
      width: 110,
      icon: PhoneIncoming,
      visible: false,
      editable: false,
      sortable: true,
      getValue: (c) => c.inboundCalls,
    },
    {
      id: 'outboundCalls',
      name: tc.columns.outbound,
      type: 'number',
      width: 110,
      icon: PhoneOutgoing,
      visible: false,
      editable: false,
      sortable: true,
      getValue: (c) => c.outboundCalls,
    },
    {
      id: 'totalMinutes',
      name: tc.columns.totalTime,
      type: 'text',
      width: 120,
      icon: Clock,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => formatTotalTime(c.totalMinutes),
    },
    {
      id: 'lastCallDate',
      name: tc.columns.lastCall,
      type: 'date',
      width: 140,
      icon: Calendar,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (c) => c.lastCallDate,
    },
    {
      id: 'createdAt',
      name: tc.columns.added,
      type: 'date',
      width: 140,
      icon: Calendar,
      visible: false,
      editable: false,
      sortable: true,
      getValue: (c) => c.createdAt,
    },
  ];
}

function CallContactsContent() {
  const { setIsDialerOpen, setInitialDialerNumber } = useCall();
  const t = getTranslations('weldmeet');
  const tc = t.weldcall.contacts;

  const contacts = sampleContacts;

  const callContactStatusConfig: Record<string, StatusStyle> = useMemo(() => ({
    frequent: { label: tc.status.frequent, ...callContactStatusColors.frequent },
    regular: { label: tc.status.regular, ...callContactStatusColors.regular },
    occasional: { label: tc.status.occasional, ...callContactStatusColors.occasional },
    inactive: { label: tc.status.inactive, ...callContactStatusColors.inactive },
  }), [tc]);

  const callContactGridConfig: EntityGridConfig<CallContact> = useMemo(() => ({
    entityName: tc.entityName,
    gridViewName: 'weldcall-contact',
    entityNamePlural: tc.entityNamePlural,
    columns: buildCallContactColumns(tc),
    getEntityId: (c) => c.id,
    getEntityName: getContactName,
    getEntityInitials: getContactInitials,
    getEntitySubtitle: getContactSubtitle,
    statusField: 'status',
    statusConfig: callContactStatusConfig,
    allowCustomColumns: false,
    enableCalculations: false,
    enableInlineEditing: false,
    enableRowSelection: true,
    enableExport: false,
    enableImport: false,
  }), [tc, callContactStatusConfig]);

  const pagination: GridPaginationState = {
    page: 1,
    pageSize: 25,
    totalCount: contacts.length,
    totalPages: 1,
  };

  const actions: EntityGridActions<CallContact> = useMemo(
    () => ({
      onUpdateEntity: async () => ({ success: true }),
      onDeleteEntity: async () => ({ success: true }),
      onRowClick: (contact) => {
        setInitialDialerNumber(contact.phone);
        setIsDialerOpen(true);
      },
      onCreateEntity: () => {
        toast.info(tc.createContact);
      },
    }),
    [setIsDialerOpen, setInitialDialerNumber, tc],
  );

  return (
    <div className="h-[calc(100vh-4rem)]">
      <EntityGrid
        config={callContactGridConfig}
        actions={actions}
        entities={contacts}
        pagination={pagination}
      />
    </div>
  );
}

export default function CallContactsPage() {
  return (
    <WeldCallGate>
      <CallContactsContent />
    </WeldCallGate>
  );
}
