/**
 * Record chats on the client: the chats attached to companies, people, tasks,
 * projects and domains (`chat_channels.type = 'entity'`). One place for each
 * type's labels, icon and record panel, used by the WeldChat sidebar groups,
 * the record chat header and the record panels' chat.
 *
 * The server decides who can read and who follows a chat
 * (`apps/workers/chat-api/src/services/chat/entity-channels/`); this map only
 * says how to show one. Add a type here when chat-api gets a provider for it.
 */

import { Briefcase, Building2, CheckSquare, Globe, User, type LucideIcon } from 'lucide-react';
import {
  RECORD_CHAT_TYPES,
  type RecordChatType,
} from '@weldsuite/app-api-client/schemas/chat-entity-channels';
import { RECORD_GROUP_PREFIX } from './group-filter';

export { RECORD_CHAT_TYPES, type RecordChatType };

export interface RecordChatTypeInfo {
  type: RecordChatType;
  /** Plural, for the sidebar group and the breadcrumb ("Companies"). */
  groupLabelKey: string;
  /** Singular, for the chat header's subtitle ("Company"). */
  labelKey: string;
  /** The button that opens the record ("Open company"). */
  openLabelKey: string;
  icon: LucideIcon;
  /** Object panel that shows the record (`components/objects/<panelType>`). */
  panelType: string;
}

const K = 'sweep.weldchat.recordChats';

const RECORD_CHAT_TYPE_INFO: Record<RecordChatType, RecordChatTypeInfo> = {
  company: {
    type: 'company',
    groupLabelKey: `${K}.groups.company`,
    labelKey: `${K}.types.company`,
    openLabelKey: `${K}.open.company`,
    icon: Building2,
    panelType: 'company',
  },
  person: {
    type: 'person',
    groupLabelKey: `${K}.groups.person`,
    labelKey: `${K}.types.person`,
    openLabelKey: `${K}.open.person`,
    icon: User,
    panelType: 'person',
  },
  task: {
    type: 'task',
    groupLabelKey: `${K}.groups.task`,
    labelKey: `${K}.types.task`,
    openLabelKey: `${K}.open.task`,
    icon: CheckSquare,
    panelType: 'task',
  },
  project: {
    type: 'project',
    groupLabelKey: `${K}.groups.project`,
    labelKey: `${K}.types.project`,
    openLabelKey: `${K}.open.project`,
    icon: Briefcase,
    panelType: 'project',
  },
  domain: {
    type: 'domain',
    groupLabelKey: `${K}.groups.domain`,
    labelKey: `${K}.types.domain`,
    openLabelKey: `${K}.open.domain`,
    icon: Globe,
    panelType: 'domain',
  },
};

export function isRecordChatType(type: string | null | undefined): type is RecordChatType {
  return !!type && (RECORD_CHAT_TYPES as readonly string[]).includes(type);
}

/** How to show a record chat type, or null for a type WeldChat does not list (legacy `contact`, …). */
export function getRecordChatTypeInfo(type: string | null | undefined): RecordChatTypeInfo | null {
  return isRecordChatType(type) ? RECORD_CHAT_TYPE_INFO[type] : null;
}

/** Sidebar group key of a record type, `record:<type>`. */
export function recordGroupKey(type: RecordChatType): string {
  return `${RECORD_GROUP_PREFIX}${type}`;
}

/** WeldChat route of a record chat. */
export function recordChatHref(channelId: string): string {
  return `/weldchat/${channelId}`;
}

/** The record chats page, filtered to one type. */
export function recordChatsPageHref(type: RecordChatType): string {
  return `/weldchat/records?type=${type}`;
}

/** Opens the record's object panel (`useObjectPanel().open`). */
export function openRecordPanel(
  open: (opts: { type: string; id: string }) => void,
  type: RecordChatType,
  entityId: string,
): void {
  open({ type: RECORD_CHAT_TYPE_INFO[type].panelType, id: entityId });
}
