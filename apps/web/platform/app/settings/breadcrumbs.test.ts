import { describe, it, expect } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { buildBreadcrumbSegments } from './breadcrumbs';

const labels = (pathname: string) =>
  buildBreadcrumbSegments(pathname, en.settings.title, en.settings.menu).map((s) => s.label);

describe('buildBreadcrumbSegments', () => {
  it('shows the profile label on the settings index', () => {
    expect(labels('/settings')).toEqual([en.settings.title, 'Profile']);
  });

  it('uses the translated menu title instead of the raw segment', () => {
    expect(labels('/settings/api-keys')).toEqual([en.settings.title, 'API Keys']);
    expect(labels('/settings/team')).toEqual([en.settings.title, 'Team Members']);
    expect(labels('/settings/activity')).toEqual([en.settings.title, 'Activity Log']);
  });

  it('labels the legacy /settings/general alias like Business Settings', () => {
    expect(labels('/settings/general')).toEqual([en.settings.title, 'Business Settings']);
    expect(labels('/settings/business')).toEqual([en.settings.title, 'Business Settings']);
  });

  it('follows the active locale', () => {
    const segments = buildBreadcrumbSegments('/settings/general', nl.settings.title, nl.settings.menu);
    expect(segments.at(-1)?.label).toBe(nl.settings.menu.businessSettings);
  });

  it('keeps the weld* overrides and links the parent segments', () => {
    expect(buildBreadcrumbSegments('/settings/apps/weldcrm', en.settings.title, en.settings.menu)).toEqual([
      { label: en.settings.title, href: '/settings' },
      { label: 'Apps', href: '/settings/apps' },
      { label: 'WeldCRM' },
    ]);
  });

  it('falls back to a capitalized segment for unknown paths', () => {
    expect(labels('/settings/some-new-page')).toEqual([en.settings.title, 'Some new page']);
  });
});
