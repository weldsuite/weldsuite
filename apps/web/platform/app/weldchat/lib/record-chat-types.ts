/**
 * Record chats on the client: the chats attached to companies, people, tasks,
 * projects, domains, sheets and documents (`chat_channels.type = 'entity'`).
 * One place for each type's labels, app logo and where the record opens, used by
 * the WeldChat sidebar groups, the record chat header and the record panels'
 * chat. A sheet's or a document's chat holds its comment threads (ADR
 * CHAT-007).
 *
 * The server decides who can read and who follows a chat
 * (`apps/workers/chat-api/src/services/chat/entity-channels/`); this map only
 * says how to show one. Add a type here when chat-api gets a provider for it.
 */

import {
  BOOKS_RECORD_CHAT_TYPES,
  RECORD_CHAT_TYPES as BASE_RECORD_CHAT_TYPES,
  type BooksRecordChatType,
  type RecordChatType as BaseRecordChatType,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { isFeatureAvailable } from '@/lib/edition';
import { RECORD_GROUP_PREFIX } from './group-filter';
import { appLogoIcon, type AppLogoIconComponent } from './app-logo-icon';

export { BOOKS_RECORD_CHAT_TYPES, type BooksRecordChatType };

/**
 * Every record type this client knows how to show: the base ones, then
 * WeldBooks' six (invoice, bill, bank line, inbox document, VAT return,
 * contact). The WeldBooks ones are offered only where the edition has
 * `books-questions` (the Rust backend), see {@link isRecordChatType}.
 */
export const RECORD_CHAT_TYPES = [...BASE_RECORD_CHAT_TYPES, ...BOOKS_RECORD_CHAT_TYPES] as const;
export type RecordChatType = BaseRecordChatType | BooksRecordChatType;

export interface RecordChatTypeInfo {
  type: RecordChatType;
  /** Plural, for the sidebar group and the breadcrumb ("Companies"). */
  groupLabelKey: string;
  /** Singular, for the chat header's subtitle ("Company"). */
  labelKey: string;
  /** The button that opens the record ("Open company"). */
  openLabelKey: string;
  /** The logo of the app the record lives in (WeldCRM's, WeldBoard's, …). */
  icon: AppLogoIconComponent;
  /** Object panel that shows the record (`components/objects/<panelType>`)... */
  panelType?: string;
  /** ...or the page that does (a spreadsheet, a document). */
  href?: (entityId: string) => string;
}

const K = 'sweep.weldchat.recordChats';

const RECORD_CHAT_TYPE_INFO: Record<RecordChatType, RecordChatTypeInfo> = {
  company: {
    type: 'company',
    groupLabelKey: `${K}.groups.company`,
    labelKey: `${K}.types.company`,
    openLabelKey: `${K}.open.company`,
    icon: appLogoIcon('weldcrm'),
    panelType: 'company',
  },
  person: {
    type: 'person',
    groupLabelKey: `${K}.groups.person`,
    labelKey: `${K}.types.person`,
    openLabelKey: `${K}.open.person`,
    icon: appLogoIcon('weldcrm'),
    panelType: 'person',
  },
  task: {
    type: 'task',
    groupLabelKey: `${K}.groups.task`,
    labelKey: `${K}.types.task`,
    openLabelKey: `${K}.open.task`,
    icon: appLogoIcon('weldflow'),
    panelType: 'task',
  },
  project: {
    type: 'project',
    groupLabelKey: `${K}.groups.project`,
    labelKey: `${K}.types.project`,
    openLabelKey: `${K}.open.project`,
    icon: appLogoIcon('weldflow'),
    panelType: 'project',
  },
  domain: {
    type: 'domain',
    groupLabelKey: `${K}.groups.domain`,
    labelKey: `${K}.types.domain`,
    openLabelKey: `${K}.open.domain`,
    icon: appLogoIcon('weldhost'),
    panelType: 'domain',
  },
  sheet: {
    type: 'sheet',
    groupLabelKey: `${K}.groups.sheet`,
    labelKey: `${K}.types.sheet`,
    openLabelKey: `${K}.open.sheet`,
    icon: appLogoIcon('weldsheets'),
    href: (id) => `/weldsheets/${encodeURIComponent(id)}`,
  },
  doc: {
    type: 'doc',
    groupLabelKey: `${K}.groups.doc`,
    labelKey: `${K}.types.doc`,
    openLabelKey: `${K}.open.doc`,
    icon: appLogoIcon('welddocs'),
    href: (id) => `/welddocs/${encodeURIComponent(id)}`,
  },
  board: {
    type: 'board',
    groupLabelKey: `${K}.groups.board`,
    labelKey: `${K}.types.board`,
    openLabelKey: `${K}.open.board`,
    icon: appLogoIcon('weldboard'),
    href: (id) => `/weldboard/${encodeURIComponent(id)}`,
  },
  // WeldBooks' records (edition feature `books-questions`, ADR BOOKS-015). Their chats hold the
  // questions to the accountant; the panel types are the ones the WeldBooks lists stack.
  invoice: {
    type: 'invoice',
    groupLabelKey: `${K}.groups.invoice`,
    labelKey: `${K}.types.invoice`,
    openLabelKey: `${K}.open.invoice`,
    icon: appLogoIcon('weldbooks'),
    panelType: 'invoice',
  },
  bill: {
    type: 'bill',
    groupLabelKey: `${K}.groups.bill`,
    labelKey: `${K}.types.bill`,
    openLabelKey: `${K}.open.bill`,
    icon: appLogoIcon('weldbooks'),
    panelType: 'bill',
  },
  bank_transaction: {
    type: 'bank_transaction',
    groupLabelKey: `${K}.groups.bank_transaction`,
    labelKey: `${K}.types.bank_transaction`,
    openLabelKey: `${K}.open.bank_transaction`,
    icon: appLogoIcon('weldbooks'),
    panelType: 'bank_transaction',
  },
  // An inbox document has no panel: it opens on the documents page.
  accounting_document: {
    type: 'accounting_document',
    groupLabelKey: `${K}.groups.accounting_document`,
    labelKey: `${K}.types.accounting_document`,
    openLabelKey: `${K}.open.accounting_document`,
    icon: appLogoIcon('weldbooks'),
    href: (id) => `/weldbooks/documents?document=${encodeURIComponent(id)}`,
  },
  vat_return: {
    type: 'vat_return',
    groupLabelKey: `${K}.groups.vat_return`,
    labelKey: `${K}.types.vat_return`,
    openLabelKey: `${K}.open.vat_return`,
    icon: appLogoIcon('weldbooks'),
    panelType: 'vat_return',
  },
  accounting_contact: {
    type: 'accounting_contact',
    groupLabelKey: `${K}.groups.accounting_contact`,
    labelKey: `${K}.types.accounting_contact`,
    openLabelKey: `${K}.open.accounting_contact`,
    icon: appLogoIcon('weldbooks'),
    panelType: 'weldbooks_contact',
  },
};

const BOOKS_TYPES: readonly string[] = BOOKS_RECORD_CHAT_TYPES;

/**
 * A type WeldChat lists. WeldBooks' types count only where the edition has
 * `books-questions`: Global's chat has no provider for them.
 */
export function isRecordChatType(type: string | null | undefined): type is RecordChatType {
  if (!type || !(RECORD_CHAT_TYPES as readonly string[]).includes(type)) return false;
  return !BOOKS_TYPES.includes(type) || isFeatureAvailable('books-questions');
}

/** How to show a record chat type, or null for a type WeldChat does not list (legacy `contact`, …). */
export function getRecordChatTypeInfo(type: string | null | undefined): RecordChatTypeInfo | null {
  return isRecordChatType(type) ? RECORD_CHAT_TYPE_INFO[type] : null;
}

/** The record types WeldChat lists on this deployment, in the sidebar's fixed order. */
export function offeredRecordChatTypes(): RecordChatType[] {
  return RECORD_CHAT_TYPES.filter((type) => isRecordChatType(type));
}

/** Sidebar group key of a record type, `record:<type>`. */
export function recordGroupKey(type: RecordChatType): string {
  return `${RECORD_GROUP_PREFIX}${type}`;
}

/** WeldChat route of a record chat. */
export function recordChatHref(channelId: string): string {
  return `/weldchat/${channelId}`;
}

/** Route of the record chats page (`src/routes/weldchat/records/`). */
export const RECORD_CHATS_PAGE_PATH = '/weldchat/records';

/** The record chats page, filtered to one type. */
export function recordChatsPageHref(type: RecordChatType): string {
  return `${RECORD_CHATS_PAGE_PATH}?type=${type}`;
}

/** Opens the record: its object panel (`useObjectPanel().open`), or its page (`useRouter().push`). */
export function openRecordPanel(
  open: (opts: { type: string; id: string }) => void,
  type: RecordChatType,
  entityId: string,
  push: (href: string) => void,
): void {
  const info = RECORD_CHAT_TYPE_INFO[type];
  if (info.href) push(info.href(entityId));
  else if (info.panelType) open({ type: info.panelType, id: entityId });
}
