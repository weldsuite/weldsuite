/**
 * Type → label / icon mapping for the global Cmd+K palette.
 * Keep in sync with SEARCH_ENTITY_TYPES in @weldsuite/core-api-client/schemas/search.
 */

import type { ComponentType } from 'react';
import {
  Contact,
  Building2,
  UserPlus,
  Target,
  TicketCheck,
  BookOpen,
  Package,
  ShoppingCart,
  FileText,
  Receipt,
  Briefcase,
  CheckSquare,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import type { SearchEntityType } from '@weldsuite/core-api-client/schemas/search';

export const RESULT_TYPE_LABEL: Record<SearchEntityType, string> = {
  contact: 'Contacts',
  customer: 'Customers',
  lead: 'Leads',
  opportunity: 'Opportunities',
  ticket: 'Tickets',
  article: 'Articles',
  product: 'Products',
  order: 'Orders',
  invoice: 'Invoices',
  bill: 'Bills',
  project: 'Projects',
  task: 'Tasks',
  domain: 'Domains',
};

export const RESULT_TYPE_ICON: Record<SearchEntityType, LucideIcon | ComponentType<{ className?: string }>> = {
  contact: Contact,
  customer: Building2,
  lead: UserPlus,
  opportunity: Target,
  ticket: TicketCheck,
  article: BookOpen,
  product: Package,
  order: ShoppingCart,
  invoice: FileText,
  bill: Receipt,
  project: Briefcase,
  task: CheckSquare,
  domain: Globe,
};
