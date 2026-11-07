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
  Sheet,
  SquareDashedMousePointer,
  CircleDot,
  GitPullRequest,
  type LucideIcon,
} from 'lucide-react';
import type { SearchEntityType } from '@weldsuite/core-api-client/schemas/search';

/**
 * The record types the palette can label: the search API's, plus WeldMerge's
 * (`merge_issue`, `merge_pull_request`). Naming them here keeps the maps complete
 * whether or not the API's `SEARCH_ENTITY_TYPES` lists them yet.
 */
export type PaletteEntityType = SearchEntityType | 'merge_issue' | 'merge_pull_request';

// `contact` / `customer` are the legacy search type keys for CRM people and
// companies; the UI calls them People and Companies.
export const RESULT_TYPE_LABEL: Record<PaletteEntityType, string> = {
  contact: 'People',
  customer: 'Companies',
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
  sheet: 'Spreadsheets',
  board: 'Boards',
  domain: 'Domains',
  merge_issue: 'Issues',
  merge_pull_request: 'Pull requests',
};

export const RESULT_TYPE_ICON: Record<PaletteEntityType, LucideIcon | ComponentType<{ className?: string }>> = {
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
  sheet: Sheet,
  board: SquareDashedMousePointer,
  domain: Globe,
  merge_issue: CircleDot,
  merge_pull_request: GitPullRequest,
};
