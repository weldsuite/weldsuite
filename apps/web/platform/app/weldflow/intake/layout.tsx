import type { ReactNode } from 'react';
import { usePathname } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { SubNavPills, activeSubNavId, type SubNavItem } from '@/app/weldflow/components/sub-nav';

const BASE_PATH = '/weldflow/intake';

/** Intake: the request pipeline and the roadmap, under pills. */
export default function IntakeLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const pathname = usePathname();
  const copy = t.projects.subNav.intake;
  const items: SubNavItem[] = [
    { id: 'requests', label: copy.requests, path: '' },
    { id: 'roadmap', label: copy.roadmap, path: '/roadmap' },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SubNavPills
        label={copy.label}
        basePath={BASE_PATH}
        items={items}
        activeId={activeSubNavId(pathname, BASE_PATH, items)}
      />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
