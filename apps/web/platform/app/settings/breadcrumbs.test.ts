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

  it('labels the single sign-on page in the active locale', () => {
    expect(labels('/settings/sso')).toEqual([en.settings.title, 'Single sign-on']);
    const segments = buildBreadcrumbSegments('/settings/sso', nl.settings.title, nl.settings.menu);
    expect(segments.at(-1)?.label).toBe(nl.settings.menu.sso);
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

  it('keeps the WeldHR override', () => {
    expect(buildBreadcrumbSegments('/settings/apps/weldhr', en.settings.title, en.settings.menu)).toEqual([
      { label: en.settings.title, href: '/settings' },
      { label: 'Apps', href: '/settings/apps' },
      { label: 'WeldHR' },
    ]);
  });

  it('labels the entities pages and leaves the entity id out', () => {
    expect(labels('/settings/entities')).toEqual([en.settings.title, 'Entities']);
    expect(buildBreadcrumbSegments('/settings/entities/ent_123/edit', en.settings.title, en.settings.menu)).toEqual([
      { label: en.settings.title, href: '/settings' },
      { label: 'Entities', href: '/settings/entities' },
      { label: 'Edit entity' },
    ]);
    expect(labels('/settings/entities/add')).toEqual([en.settings.title, 'Entities', 'New entity']);
  });

  it('puts an entity\'s invoice templates and their designer under the entity, without the ids', () => {
    expect(buildBreadcrumbSegments('/settings/entities/ent_123/invoice-templates', en.settings.title, en.settings.menu)).toEqual([
      { label: en.settings.title, href: '/settings' },
      { label: 'Entities', href: '/settings/entities' },
      { label: 'Edit entity', href: '/settings/entities/ent_123/edit' },
      { label: 'Invoice templates' },
    ]);
    expect(
      buildBreadcrumbSegments('/settings/entities/ent_123/invoice-templates/itpl_9', en.settings.title, en.settings.menu),
    ).toEqual([
      { label: en.settings.title, href: '/settings' },
      { label: 'Entities', href: '/settings/entities' },
      { label: 'Edit entity', href: '/settings/entities/ent_123/edit' },
      { label: 'Invoice templates', href: '/settings/entities/ent_123/invoice-templates' },
      { label: 'Edit template' },
    ]);
  });

  it('falls back to a capitalized segment for unknown paths', () => {
    expect(labels('/settings/some-new-page')).toEqual([en.settings.title, 'Some new page']);
  });
});
