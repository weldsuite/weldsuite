import { afterEach, describe, expect, it } from 'vitest';
import { isRouteOffered, routeRequirement } from './edition-routes';
import { setRuntimeConfig } from './runtime-config';

const EU_CONFIG = {
  backend: 'rust',
  edition: 'eu',
  modules: ['core', 'know', 'sign', 'pass', 'calendar'],
  unavailableFeatures: ['sso-connections', 'billing', 'credit-top-up', 'paid-apps', 'desktop-sign-in', 'analytics', 'search-reindex'],
};

afterEach(() => setRuntimeConfig(null));

describe('route availability', () => {
  it('offers every page on Global', () => {
    for (const path of ['/weldcrm/companies', '/agents', '/settings/billing', '/settings/sso', '/social/posts']) {
      expect(isRouteOffered(path)).toBe(true);
    }
  });

  it('maps a page to the module of its app', () => {
    expect(routeRequirement('/weldcrm/companies')).toEqual({ modules: ['crm'] });
    expect(routeRequirement('/weldflow')).toEqual({ modules: ['flow'] });
    expect(routeRequirement('/social/posts')).toEqual({ modules: ['social'] });
    expect(routeRequirement('/settings/apps/weldmail/signatures')).toEqual({ modules: ['mail'] });
    expect(routeRequirement('/agents/abc')).toEqual({ modules: ['agent'] });
    expect(routeRequirement('/settings/billing')).toEqual({ feature: 'billing' });
  });

  it('needs only core for platform pages', () => {
    for (const path of ['/', '/settings', '/settings/team', '/appstore', '/apps/my-app', '/objects/machines', '/documents/f_1', '/settings/apps/weldsuite']) {
      expect(routeRequirement(path), path).toBeNull();
    }
  });

  it('matches whole segments only', () => {
    expect(routeRequirement('/settings/ssox')).toBeNull();
    expect(routeRequirement('/agentsx')).toBeNull();
  });

  it('on the EU edition, offers the ported modules and core, nothing else', () => {
    setRuntimeConfig(EU_CONFIG);
    for (const path of ['/', '/weldknow', '/weldsign/documents', '/weldpass', '/weldcalendar/week', '/welddrive', '/settings/team', '/settings/apps/weldcalendar', '/appstore']) {
      expect(isRouteOffered(path), path).toBe(true);
    }
    for (const path of [
      '/weldcrm/companies',
      '/weldmail',
      '/weldchat',
      '/agents',
      '/new-chat',
      '/call-room',
      '/social',
      '/settings/sso',
      '/settings/plans',
      '/settings/billing/invoices',
      '/settings/integrations',
      '/settings/webhooks',
      '/settings/entities',
      '/settings/apps/phone-numbers',
      '/settings/apps/weldmail',
    ]) {
      expect(isRouteOffered(path), path).toBe(false);
    }
  });

  it('offers a page shared by two modules when either is served', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'hr'] });
    expect(isRouteOffered('/settings/entities')).toBe(true);
  });
});
