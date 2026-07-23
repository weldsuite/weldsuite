import {
  LayoutGrid,
  SquareActivity,
  Users,
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
 * Tab descriptors for the company panel — same set + ordering as the
 * legacy customer panel so the two feel identical, with a single difference:
 * the Contacts tab is labelled "People" because the Companies + People
 * refactor renamed the entity. Tabs other than Details + Contacts/People
 * render `ComingSoonTab` until the cross-module Phase 9 rewrites land.
 */
export interface CompanyTab extends ObjectPanelTabDescriptor {
  id:
    | 'overview'
    | 'activity'
    | 'people'
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

export const COMPANY_TABS: CompanyTab[] = [
  { id: 'overview', label: 'Details', icon: LayoutGrid, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'activity', label: 'Activity', icon: SquareActivity, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'people', label: 'People', icon: Users, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'emails', label: 'Emails', icon: Mail, defaultVisibleInFullscreen: true },
  { id: 'calls', label: 'Calls', icon: Phone, defaultVisibleInFullscreen: true },
  { id: 'deals', label: 'Pipeline', icon: SquareKanban, defaultVisibleInFullscreen: true },
  { id: 'notes', label: 'Notes', icon: StickyNote, defaultVisibleInFullscreen: true },
  { id: 'meetings', label: 'Meetings', icon: Video, defaultVisibleInFullscreen: true },
  { id: 'tasks', label: 'Tasks', icon: SquareCheck, defaultVisibleInFullscreen: true },
  { id: 'files', label: 'Files', icon: Folder, defaultVisibleInFullscreen: true },
  { id: 'audit', label: 'Audit Log', icon: History, defaultVisibleInFullscreen: true },
];
