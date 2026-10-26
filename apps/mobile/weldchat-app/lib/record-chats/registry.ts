/**
 * Record chats on mobile: the chats attached to companies, people, tasks,
 * projects and domains (`chat_channels.type = 'entity'`). One place for each
 * type's labels and icon, used by the Home groups, the records screen and the
 * record chat header.
 *
 * Mirrors apps/web/platform/app/weldchat/lib/record-chat-types.ts. The server
 * decides who can read and who follows a chat; this map only says how to show
 * one. Add a type here when chat-api gets a provider for it.
 */

import { Briefcase, Building2, Globe, SquareCheck, User, type LucideIcon } from 'lucide-react-native';

import type { Translations } from '@/lib/i18n';
import { isRecordChatType, type RecordChatType } from './rules';

export { RECORD_CHAT_TYPES, isRecordChatType, recordChatName, type RecordChatType } from './rules';

const ICONS: Record<RecordChatType, LucideIcon> = {
  company: Building2,
  person: User,
  task: SquareCheck,
  project: Briefcase,
  domain: Globe,
};

/** The type's icon, or null for a type WeldChat does not list (legacy `contact`, …). */
export function recordChatIcon(type: string | null | undefined): LucideIcon | null {
  return isRecordChatType(type) ? ICONS[type] : null;
}

/** Plural, for the Home group and the type chips ("Companies"). */
export function recordGroupLabel(t: Translations, type: RecordChatType): string {
  return t.recordChats.groups[type];
}

/** Singular, for the chat header's subtitle ("Company"). */
export function recordTypeLabel(t: Translations, type: RecordChatType): string {
  return t.recordChats.types[type];
}
