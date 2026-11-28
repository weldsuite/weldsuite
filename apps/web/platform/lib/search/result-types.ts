/**
 * Type → label / icon mapping for search results (the Cmd/Ctrl+K palette,
 * WeldChat mentions, WeldAgent record tags). Every record type the search API
 * returns (`SEARCH_ENTITY_TYPES` in @weldsuite/app-api-client/schemas/search)
 * has an entry; the `Record` types make a missing one a type error.
 */

import type { ComponentType } from 'react';
import {
  Contact,
  Building2,
  UserPlus,
  Target,
  TicketCheck,
  BookOpen,
  BookOpenText,
  Bot,
  ChartSpline,
  ClipboardList,
  File,
  Hash,
  List,
  MessagesSquare,
  NotebookText,
  Package,
  FileText,
  Inbox,
  Landmark,
  Receipt,
  Briefcase,
  CheckSquare,
  Globe,
  Send,
  Sheet,
  ShoppingCart,
  Signature,
  SquareDashedMousePointer,
  Users,
  CircleDot,
  GitPullRequest,
  Video,
  Warehouse,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { SearchEntityType } from '@weldsuite/app-api-client/schemas/search';

export type PaletteEntityType = SearchEntityType;

/**
 * English labels, for surfaces without translations. The palette uses
 * {@link resultTypeLabel}. `contact` / `customer` are the legacy search type
 * keys for CRM people and companies; the UI calls them People and Companies.
 */
export const RESULT_TYPE_LABEL: Record<PaletteEntityType, string> = {
  contact: 'People',
  customer: 'Companies',
  lead: 'Leads',
  opportunity: 'Opportunities',
  ticket: 'Tickets',
  conversation: 'Conversations',
  article: 'Articles',
  knowledge_page: 'Knowledge pages',
  product: 'Products',
  order: 'Orders',
  warehouse: 'Warehouses',
  invoice: 'Invoices',
  bill: 'Bills',
  project: 'Projects',
  task: 'Tasks',
  merge_issue: 'Issues',
  merge_pull_request: 'Pull requests',
  document: 'Documents',
  sheet: 'Spreadsheets',
  board: 'Boards',
  form: 'Forms',
  sign_envelope: 'Signing requests',
  drive_file: 'Files',
  meeting: 'Meetings',
  chat_channel: 'Channels',
  reach_campaign: 'Outreach campaigns',
  data_list: 'Lead lists',
  panel_project: 'Analytics projects',
  workflow: 'Workflows',
  agent: 'Agents',
  domain: 'Domains',
  bank_transaction: 'Bank transactions',
  accounting_contact: 'Accounting contacts',
  accounting_document: 'Inbox documents',
};

export const RESULT_TYPE_ICON: Record<PaletteEntityType, LucideIcon | ComponentType<{ className?: string }>> = {
  contact: Contact,
  customer: Building2,
  lead: UserPlus,
  opportunity: Target,
  ticket: TicketCheck,
  conversation: MessagesSquare,
  article: BookOpen,
  knowledge_page: BookOpenText,
  product: Package,
  order: ShoppingCart,
  warehouse: Warehouse,
  invoice: FileText,
  bill: Receipt,
  project: Briefcase,
  task: CheckSquare,
  merge_issue: CircleDot,
  merge_pull_request: GitPullRequest,
  document: NotebookText,
  sheet: Sheet,
  board: SquareDashedMousePointer,
  form: ClipboardList,
  sign_envelope: Signature,
  drive_file: File,
  meeting: Video,
  chat_channel: Hash,
  reach_campaign: Send,
  data_list: List,
  panel_project: ChartSpline,
  workflow: Workflow,
  agent: Bot,
  domain: Globe,
  bank_transaction: Landmark,
  accounting_contact: Users,
  accounting_document: Inbox,
};

/** The record-type headings of any locale (each locale types its strings as literals). */
type RecordTypeCopy = {
  sweep: { shared: { commandPalette: { recordTypes: Readonly<Partial<Record<string, string>>> } } };
};

/** The translated group heading for a record type, or the type itself for one this build doesn't know. */
export function resultTypeLabel(t: RecordTypeCopy, type: string): string {
  return t.sweep.shared.commandPalette.recordTypes[type] ?? type;
}
