import {
  User,
  CircleCheck,
  Mail,
  Phone,
  Building,
  Tag,
  Calendar,
  MessageSquare,
  FileText,
} from 'lucide-react';
import type { Customer } from '@/hooks/queries/use-helpdesk-queries';
import {
  EntityGridConfig,
  GridColumnDef,
  StatusStyle,
} from '@/components/entity-grid';

// Helper functions
function getCustomerInitials(customer: Customer): string {
  const parts = customer.name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return customer.name.charAt(0).toUpperCase();
}

function getCustomerSubtitle(customer: Customer): string | undefined {
  return customer.company || customer.email || undefined;
}

interface CustomerGridTranslations {
  name: string;
  email: string;
  status: string;
  company: string;
  phone: string;
  conversations: string;
  lastContact: string;
  tags: string;
  loyaltyTier: string;
  notes: string;
  active: string;
  inactive: string;
  vip: string;
  customersEntityName: string;
  customersEntityNamePlural: string;
}

export function getCustomerGridConfig(tc: CustomerGridTranslations): EntityGridConfig<Customer> {
  const customerStatusConfig: Record<string, StatusStyle> = {
    active: {
      label: tc.active,
      color: 'text-emerald-700 dark:text-emerald-400',
      bg: 'bg-emerald-50 dark:bg-emerald-950',
    },
    inactive: {
      label: tc.inactive,
      color: 'text-gray-700 dark:text-muted-foreground',
      bg: 'bg-gray-100 dark:bg-secondary',
    },
    vip: {
      label: tc.vip,
      color: 'text-purple-700 dark:text-purple-400',
      bg: 'bg-purple-50 dark:bg-purple-950',
    },
  };

  const customerColumns: GridColumnDef<Customer>[] = [
    {
      id: 'name',
      name: tc.name,
      type: 'company',
      width: 280,
      icon: User,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (customer) => customer.name,
    },
    {
      id: 'email',
      name: tc.email,
      type: 'email',
      width: 220,
      icon: Mail,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (customer) => customer.email,
    },
    {
      id: 'status',
      name: tc.status,
      type: 'single-select',
      width: 120,
      icon: CircleCheck,
      visible: true,
      editable: false,
      sortable: true,
      options: ['active', 'inactive', 'vip'],
      selectConfig: customerStatusConfig,
      getValue: (customer) => customer.status,
    },
    {
      id: 'company',
      name: tc.company,
      type: 'text',
      width: 180,
      icon: Building,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (customer) => customer.company || '',
    },
    {
      id: 'phone',
      name: tc.phone,
      type: 'phone',
      width: 150,
      icon: Phone,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (customer) => customer.phone || '',
    },
    {
      id: 'conversationCount',
      name: tc.conversations,
      type: 'number',
      width: 130,
      icon: MessageSquare,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (customer) => customer.conversationCount || 0,
    },
    {
      id: 'lastContact',
      name: tc.lastContact,
      type: 'date',
      width: 140,
      icon: Calendar,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (customer) => customer.lastContact,
    },
    {
      id: 'tags',
      name: tc.tags,
      type: 'multi-select',
      width: 200,
      icon: Tag,
      visible: false,
      editable: false,
      sortable: false,
      options: [],
      getValue: (customer) => customer.tags || [],
    },
    {
      id: 'loyaltyTier',
      name: tc.loyaltyTier,
      type: 'text',
      width: 130,
      icon: User,
      visible: false,
      editable: false,
      sortable: true,
      getValue: (customer) => customer.loyaltyTier || '',
    },
    {
      id: 'notes',
      name: tc.notes,
      type: 'text',
      width: 250,
      icon: FileText,
      visible: false,
      editable: false,
      sortable: false,
      getValue: (customer) => customer.notes || '',
    },
  ];

  return {
    entityName: tc.customersEntityName,
    entityNamePlural: tc.customersEntityNamePlural,
    columns: customerColumns,
    getEntityId: (customer) => customer.id,
    getEntityName: (customer) => customer.name,
    getEntityInitials: getCustomerInitials,
    getEntitySubtitle: getCustomerSubtitle,
    statusField: 'status',
    statusConfig: customerStatusConfig,
    allowCustomColumns: false,
    enableCalculations: false,
    enableInlineEditing: false,
    enableRowSelection: true,
    enableExport: false,
    enableImport: false,
  };
}
