import {
  ChartNoAxesGantt,
  SquareActivity,
  User,
  Mail,
  Phone,
  SquareKanban,
  StickyNote,
  Video,
  SquareCheck,
  Folder,
  History,
  Store,
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
    | 'audit'
    | 'buyers';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export const COMPANY_TABS: CompanyTab[] = [
  { id: 'overview', label: 'Details', icon: ChartNoAxesGantt, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'activity', label: 'Activity', icon: SquareActivity, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'people', label: 'People', icon: User, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'emails', label: 'Emails', icon: Mail, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'calls', label: 'Calls', icon: Phone, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'deals', label: 'Deals', icon: SquareKanban, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'notes', label: 'Notes', icon: StickyNote, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'meetings', label: 'Meetings', icon: Video, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'tasks', label: 'Tasks', icon: SquareCheck, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'files', label: 'Files', icon: Folder, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'audit', label: 'Audit Log', icon: History, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  // WeldCommerce (phase 6): only where WeldCommerce is offered and the member can read companies, see `companyTabs`.
  { id: 'buyers', label: 'Buyers', icon: Store, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
];

/** The tabs a member gets: Buyers only where WeldCommerce is offered (edition) and companies are readable. */
export function companyTabs(showBuyers: boolean): CompanyTab[] {
  return showBuyers ? COMPANY_TABS : COMPANY_TABS.filter((tab) => tab.id !== 'buyers');
}

/** Whether the Buyers tab applies, from the edition and the member's permission to read companies. */
export function canShowBuyers(commerceOffered: boolean, canReadCompanies: boolean): boolean {
  return commerceOffered && canReadCompanies;
}
