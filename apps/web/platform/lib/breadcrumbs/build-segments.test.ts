import { describe, it, expect } from 'vitest';
import {
  buildBreadcrumbSegments,
  collapseLongTrail,
  type MatchLike,
} from './build-segments';

const m = (pathname: string, extras: Partial<MatchLike> = {}): MatchLike => ({
  pathname,
  status: 'success',
  ...extras,
});

describe('buildBreadcrumbSegments', () => {
  it('uses the staticData label when no loader value', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm', { staticData: { breadcrumb: { label: 'CRM' } } }),
      m('/weldcrm/contacts', { staticData: { breadcrumb: { label: 'Contacts' } } }),
    ]);
    expect(result.hideAll).toBe(false);
    expect(result.segments.map((s) => s.label)).toEqual(['CRM', 'Contacts']);
    expect(result.segments[0].source).toBe('static');
  });

  it('loader label wins over staticData', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm/contacts', { staticData: { breadcrumb: { label: 'Contacts' } } }),
      m('/weldcrm/contacts/cont_abc', {
        staticData: { breadcrumb: { label: 'Detail' } },
        loaderData: { breadcrumbLabel: 'Jane Smith' },
      }),
    ]);
    expect(result.segments.map((s) => s.label)).toEqual(['Contacts', 'Jane Smith']);
    expect(result.segments[1].source).toBe('loader');
  });

  it('hidden segments are filtered out', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm', { staticData: { breadcrumb: { label: 'CRM' } } }),
      m('/weldcrm/customers/cust_1', {
        staticData: { breadcrumb: { hidden: true } },
        loaderData: { breadcrumbLabel: 'Acme Corp' },
      }),
    ]);
    expect(result.segments.map((s) => s.label)).toEqual(['CRM']);
  });

  it('hideAll short-circuits the entire header', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm', { staticData: { breadcrumb: { label: 'CRM' } } }),
      m('/calls/abc', { staticData: { breadcrumb: { hideAll: true } } }),
    ]);
    expect(result.hideAll).toBe(true);
  });

  it('edit-suffix nesting renders Contacts › Jane Smith › Edit', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm', { staticData: { breadcrumb: { label: 'CRM' } } }),
      m('/weldcrm/contacts', { staticData: { breadcrumb: { label: 'Contacts' } } }),
      m('/weldcrm/contacts/cont_1', {
        loaderData: { breadcrumbLabel: 'Jane Smith' },
      }),
      m('/weldcrm/contacts/cont_1/edit', {
        staticData: { breadcrumb: { label: 'Edit' } },
      }),
    ]);
    expect(result.segments.map((s) => s.label)).toEqual([
      'CRM',
      'Contacts',
      'Jane Smith',
      'Edit',
    ]);
  });

  it('falls back to the path-label registry for unmigrated routes', () => {
    const registry = new Map([['/weldhost', 'WeldHost']]);
    const result = buildBreadcrumbSegments(
      [m('/weldhost'), m('/weldhost/domains')],
      registry,
    );
    expect(result.segments.map((s) => s.label)).toEqual(['WeldHost', 'Domains']);
    expect(result.segments[0].source).toBe('fallback');
  });

  it('skips ID-like segments without a descriptor', () => {
    const result = buildBreadcrumbSegments([
      m('/weldhost', { staticData: { breadcrumb: { label: 'WeldHost' } } }),
      m('/weldhost/domains', { staticData: { breadcrumb: { label: 'Domains' } } }),
      m('/weldhost/domains/dom_abc123'), // no descriptor, ID-like
    ]);
    expect(result.segments.map((s) => s.label)).toEqual(['WeldHost', 'Domains']);
  });

  it('marks segment as pending when match is pending and source is not static', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm/contacts/cont_abc123', { status: 'pending' }),
    ]);
    // No descriptor, no loader, ID-like → no segment emitted at all
    expect(result.segments).toHaveLength(0);
  });

  it('segment with loader data still pending renders pending=true', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm/contacts/cont_abc123', {
        status: 'pending',
        loaderData: { breadcrumbLabel: 'Jane' },
      }),
    ]);
    expect(result.segments[0]).toMatchObject({ label: 'Jane', pending: true });
  });

  it('collapses duplicate consecutive labels', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm/contacts/cont_1', {
        loaderData: { breadcrumbLabel: 'Jane' },
      }),
      m('/weldcrm/contacts/cont_1/', {
        loaderData: { breadcrumbLabel: 'Jane' },
      }),
    ]);
    expect(result.segments).toHaveLength(1);
  });

  it('honors descriptor.href override', () => {
    const result = buildBreadcrumbSegments([
      m('/weldcrm', { staticData: { breadcrumb: { label: 'CRM', href: '/weldcrm/dashboard' } } }),
    ]);
    expect(result.segments[0].href).toBe('/weldcrm/dashboard');
  });

  it('treats UUID segments as ID-like', () => {
    const uuid = '12345678-1234-1234-1234-123456789012';
    const result = buildBreadcrumbSegments([
      m(`/weldhost/domains/${uuid}`, { staticData: { breadcrumb: { label: 'Hosts' } } }),
      m(`/weldhost/domains/${uuid}/extra`),
    ]);
    expect(result.segments.map((s) => s.label)).toEqual(['Hosts', 'Extra']);
  });
});

describe('collapseLongTrail', () => {
  const fakeSeg = (label: string) => ({
    label,
    href: '/' + label.toLowerCase(),
    pending: false,
    source: 'static' as const,
  });

  it('passes through when below the limit', () => {
    const segments = [fakeSeg('A'), fakeSeg('B'), fakeSeg('C')];
    const result = collapseLongTrail(segments);
    expect(result.ellipsis).toBe(false);
    expect(result.visible).toHaveLength(3);
  });

  it('collapses the middle when above the limit', () => {
    const segments = [
      fakeSeg('A'),
      fakeSeg('B'),
      fakeSeg('C'),
      fakeSeg('D'),
      fakeSeg('E'),
    ];
    const result = collapseLongTrail(segments, 4);
    expect(result.ellipsis).toBe(true);
    expect(result.visible.map((s) => s.label)).toEqual(['A', 'D', 'E']);
  });
});
