import {
  LayoutGrid,
  SquareActivity,
  Building,
  Users,
  Mail,
  Phone,
  StickyNote,
  Video,
  SquareCheck,
  Folder,
  History,
} from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the opportunity panel — object-specific set (no chat,
 * adds linked Company + Contacts as first-class tabs since every deal has at
 * least one of each). Tabs other than Details / Activity / Company / Contacts
 * render `ComingSoonTab` until the cross-module rewrites land.
 */
export interface OpportunityTab extends ObjectPanelTabDescriptor {
  id:
    | 'overview'
    | 'activity'
    | 'company'
    | 'contacts'
    | 'emails'
    | 'calls'
    | 'notes'
    | 'meetings'
    | 'tasks'
    | 'files'
    | 'audit';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export const OPPORTUNITY_TABS: OpportunityTab[] = [
  { id: 'overview', label: 'Details', icon: LayoutGrid, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'activity', label: 'Activity', icon: SquareActivity, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'company', label: 'Company', icon: Building, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'contacts', label: 'Contacts', icon: Users, defaultVisibleInFullscreen: true },
  { id: 'emails', label: 'Emails', icon: Mail, defaultVisibleInFullscreen: true },
  { id: 'calls', label: 'Calls', icon: Phone, defaultVisibleInFullscreen: true },
  { id: 'notes', label: 'Notes', icon: StickyNote, defaultVisibleInFullscreen: true },
  { id: 'meetings', label: 'Meetings', icon: Video, defaultVisibleInFullscreen: true },
  { id: 'tasks', label: 'Tasks', icon: SquareCheck, defaultVisibleInFullscreen: true },
  { id: 'files', label: 'Files', icon: Folder, defaultVisibleInFullscreen: true },
  { id: 'audit', label: 'Audit Log', icon: History, defaultVisibleInFullscreen: true },
];
