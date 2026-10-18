import {
  Building,
  Briefcase,
  User,
  MessageSquare,
  CheckSquare,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface EntityTypeConfig {
  value: string;
  label: string;
  icon: LucideIcon;
  module: string;
}

export const ENTITY_TYPES: EntityTypeConfig[] = [
  { value: 'company', label: 'Companies', icon: Building, module: 'CRM' },
  { value: 'person', label: 'People', icon: User, module: 'CRM' },
  { value: 'opportunity', label: 'Deals', icon: Briefcase, module: 'CRM' },
  // Conversation fields are set by WeldDesk workflows (set_conversation_attribute);
  // authoring them here gives that step's picker a definition to choose.
  { value: 'conversation', label: 'Conversations', icon: MessageSquare, module: 'WeldDesk' },
  // Values sync through flow-api's task create/PATCH and show in the task panel's Details list.
  { value: 'task', label: 'Tasks', icon: CheckSquare, module: 'WeldFlow' },
] as const;

export const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Textarea' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'single_select', label: 'Single Select' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'currency', label: 'Currency' },
  { value: 'rating', label: 'Rating' },
  { value: 'file', label: 'File Attachment' },
  { value: 'user_ref', label: 'User Reference' },
  { value: 'entity_ref', label: 'Entity Reference' },
] as const;

export function getEntityTypeConfig(value: string): EntityTypeConfig | undefined {
  return ENTITY_TYPES.find(et => et.value === value);
}

export function getFieldTypeLabel(value: string): string {
  return FIELD_TYPES.find(ft => ft.value === value)?.label ?? value;
}
