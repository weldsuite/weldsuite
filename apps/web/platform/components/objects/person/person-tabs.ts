import {
  LayoutGrid,
  SquareActivity,
  Building,
  Mail,
  Phone,
  SquareKanban,
  StickyNote,
  Video,
  SquareCheck,
  Folder,
  History,
} from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the person panel — same shape as the customer panel,
 * but the third tab is "Companies" (affiliated companies) instead of
 * "Contacts" because the Companies + People refactor inverted the
 * relationship. Tabs other than Details + Companies render
 * `ComingSoonTab` until the cross-module rewrites land.
 */
export interface PersonTab extends ObjectPanelTabDescriptor {
  id:
    | 'overview'
    | 'activity'
    | 'companies'
    | 'emails'
    | 'calls'
    | 'deals'
    | 'notes'
    | 'meetings'
    | 'tasks'
    | 'files'
    | 'audit';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export const PERSON_TABS: PersonTab[] = [
  { id: 'overview', label: 'Details', icon: LayoutGrid, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'activity', label: 'Activity', icon: SquareActivity, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'companies', label: 'Companies', icon: Building, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'emails', label: 'Emails', icon: Mail, defaultVisibleInFullscreen: true },
  { id: 'calls', label: 'Calls', icon: Phone, defaultVisibleInFullscreen: true },
  { id: 'deals', label: 'Pipeline', icon: SquareKanban, defaultVisibleInFullscreen: true },
  { id: 'notes', label: 'Notes', icon: StickyNote, defaultVisibleInFullscreen: true },
  { id: 'meetings', label: 'Meetings', icon: Video, defaultVisibleInFullscreen: true },
  { id: 'tasks', label: 'Tasks', icon: SquareCheck, defaultVisibleInFullscreen: true },
  { id: 'files', label: 'Files', icon: Folder, defaultVisibleInFullscreen: true },
  { id: 'audit', label: 'Audit Log', icon: History, defaultVisibleInFullscreen: true },
];
