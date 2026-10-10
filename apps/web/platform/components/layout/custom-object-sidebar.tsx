import type { ComponentType } from 'react';
import { Box, Settings } from 'lucide-react';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import type { ModuleSidebarConfig } from './module-sidebar-configs';

function objectIcon(name?: string): ComponentType<{ className?: string }> {
  const iconName = name || 'Box';
  return function CustomObjectIcon({ className }: { className?: string }) {
    return (
      <LucideDynamicIcon name={iconName} className={className} fallback={<Box className={className} />} />
    );
  };
}

/**
 * Build a ModuleSidebarConfig for a WeldObjects custom object at
 * `/objects/{slug}`. Each active object is its own app in the rail, so its
 * sidebar is branded with the object's plural label and the lucide icon picked
 * in the object builder (the same icon the rail shows). Record detail pages
 * keep the records item active through the sidebar's child-route matching.
 */
export function buildCustomObjectSidebarConfig(input: {
  id: string;
  slug: string;
  labelPlural: string;
  icon?: string;
}): ModuleSidebarConfig {
  const icon = objectIcon(input.icon);

  return {
    appName: input.labelPlural,
    appIcon: icon,
    getMenuItems: (t) => [
      {
        group: t.navigation.moduleSidebar.groups.general,
        items: [{ title: input.labelPlural, href: `/objects/${input.slug}`, icon }],
      },
      {
        group: t.navigation.moduleSidebar.groups.settings,
        items: [
          {
            title: t.weldobjects.sidebar.objectSettings,
            href: `/settings/custom-objects/${input.id}`,
            icon: Settings,
            permission: 'weldobjects:manage',
          },
        ],
      },
    ],
  };
}
