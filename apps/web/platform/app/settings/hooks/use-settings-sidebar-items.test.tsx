import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { getTranslations } from '@/lib/i18n';
import type { TranslationsType } from '@/lib/i18n/types';

const env = vi.hoisted(() => ({
  apps: [] as { appCode: string; status: string }[],
}));

vi.mock('@/lib/router', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/hooks/use-installed-apps', () => ({
  useInstalledApps: () => ({ data: env.apps }),
}));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      settings: getTranslations('settings'),
      helpdesk: getTranslations('helpdesk'),
    } as unknown as TranslationsType,
  }),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: () => true }),
}));

import { useSettingsSidebarItems } from './use-settings-sidebar-items';

function appTitles(): string[] {
  const { result } = renderHook(() => useSettingsSidebarItems(true));
  const apps = result.current.menuGroups.find((group) => group.items.some((item) => item.href === '/settings/apps/weldsuite'));
  return (apps?.items ?? []).map((item) => item.title);
}

beforeEach(() => {
  env.apps = [
    { appCode: 'weldstash', status: 'active' },
    { appCode: 'weldmail', status: 'active' },
  ];
});

afterEach(() => setRuntimeConfig(null));

describe('useSettingsSidebarItems WeldStash entry', () => {
  it('lists the WeldStash settings on the Rust editions', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash', 'mail'], unavailableFeatures: [] } as never);
    expect(appTitles()).toContain('WeldStash');
  });

  it('leaves WeldStash out when the app is not installed', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash', 'mail'], unavailableFeatures: [] } as never);
    env.apps = [{ appCode: 'weldmail', status: 'active' }];
    expect(appTitles()).not.toContain('WeldStash');
  });
});

describe('useSettingsSidebarItems WeldCommerce entry', () => {
  beforeEach(() => {
    env.apps = [
      { appCode: 'weldcommerce', status: 'active' },
      { appCode: 'weldmail', status: 'active' },
    ];
  });

  it('lists the WeldCommerce settings on the Rust editions, where the module exists', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'commerce', 'mail'], unavailableFeatures: [] } as never);
    expect(appTitles()).toContain('WeldCommerce');
  });

  it('leaves WeldCommerce out when the app is not installed', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'commerce', 'mail'], unavailableFeatures: [] } as never);
    env.apps = [{ appCode: 'weldmail', status: 'active' }];
    expect(appTitles()).not.toContain('WeldCommerce');
  });
});
