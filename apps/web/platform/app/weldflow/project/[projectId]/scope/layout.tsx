import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectSubNavLayout, type SubNavItem } from '@/app/weldflow/components/sub-nav';

/** The Scope tab: the scope statement and the business value (benefits). */
export default function ScopeLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const copy = t.projects.subNav.scope;
  const items: SubNavItem[] = [
    { id: 'scope', label: copy.scope, path: '' },
    { id: 'value', label: copy.value, path: '/value' },
  ];
  return (
    <ProjectSubNavLayout section="scope" label={copy.label} items={items}>
      {children}
    </ProjectSubNavLayout>
  );
}
