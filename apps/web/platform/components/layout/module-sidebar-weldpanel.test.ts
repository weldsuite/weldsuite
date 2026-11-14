import { afterEach, describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getAppLucideIcon, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { getAppPermissionObjects } from '@/lib/apps/app-permission-objects';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

afterEach(() => setRuntimeConfig(null));

describe('WeldPanel module registration', () => {
  const config = MODULE_CONFIGS.weldpanel!;
  const itemsOf = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items);

  it('is recognised as a module from its URL', () => {
    expect(getModuleKey('/weldpanel')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/projects')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/projects/wpp_1')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/insights')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/dashboards/wpd_1')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/settings')).toBe('weldpanel');
    expect(getModuleKey('/weldpanel/live')).toBe('weldpanel');
  });

  it('lists the analysis pages, the pages of the later phases and the setup, each behind its permission', () => {
    expect(itemsOf(en).map((item) => [item.href, item.permission])).toEqual([
      ['/weldpanel', 'panel_projects:read'],
      ['/weldpanel/insights', 'panel_reports:read'],
      ['/weldpanel/funnels', 'panel_reports:read'],
      ['/weldpanel/retention', 'panel_reports:read'],
      ['/weldpanel/flows', 'panel_reports:read'],
      ['/weldpanel/live', 'panel_reports:read'],
      ['/weldpanel/users', 'panel_people:read'],
      ['/weldpanel/recordings', 'panel_recordings:read'],
      ['/weldpanel/heatmaps', 'panel_reports:read'],
      ['/weldpanel/frustration', 'panel_reports:read'],
      ['/weldpanel/reports', 'panel_reports:read'],
      ['/weldpanel/dashboards', 'panel_reports:read'],
      ['/weldpanel/cohorts', 'panel_reports:read'],
      ['/weldpanel/projects', 'panel_projects:read'],
      ['/weldpanel/lexicon', 'panel_reports:read'],
      ['/weldpanel/settings', 'panel_projects:manage'],
    ]);
  });

  it('groups them', () => {
    expect(config.getMenuItems(en).map((group) => group.group)).toEqual(['General', 'Analyse', 'Behaviour', 'Saved', 'Setup']);
  });

  it('translates the section names', () => {
    expect(itemsOf(en).map((item) => item.title)).toEqual([
      'Overview',
      'Insights',
      'Funnels',
      'Retention',
      'Flows',
      'Live',
      'Users',
      'Recordings',
      'Heatmaps',
      'Frustration',
      'Reports',
      'Dashboards',
      'Cohorts',
      'Projects',
      'Lexicon',
      'Settings',
    ]);
    expect(itemsOf(nl as unknown as typeof en).map((item) => item.title).slice(0, 2)).toEqual(['Overzicht', 'Inzichten']);
  });

  it('lists only the projects where the edition has no analytics (Kubernetes)', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'panel'], unavailableFeatures: ['panel-analytics'] });
    expect(itemsOf(en).map((item) => item.href)).toEqual(['/weldpanel/projects']);
  });

  it('has an icon and its permission objects', () => {
    expect(getAppLucideIcon('weldpanel')).toBeDefined();
    expect(isHiddenFromOnboarding('weldpanel')).toBe(false);
    expect(getAppPermissionObjects('weldpanel')).toEqual(['panel_projects', 'panel_reports', 'panel_recordings', 'panel_people']);
  });
});
