import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectSubNavLayout, type SubNavItem } from '@/app/weldflow/components/sub-nav';

/** The Governance tab: status reports, decisions, change requests and stakeholders. */
export default function GovernanceLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const copy = t.projects.subNav.governance;
  const items: SubNavItem[] = [
    { id: 'status', label: copy.status, path: '' },
    { id: 'decisions', label: copy.decisions, path: '/decisions' },
    { id: 'changes', label: copy.changes, path: '/changes' },
    { id: 'stakeholders', label: copy.stakeholders, path: '/stakeholders' },
  ];
  return (
    <ProjectSubNavLayout section="governance" label={copy.label} items={items}>
      {children}
    </ProjectSubNavLayout>
  );
}
