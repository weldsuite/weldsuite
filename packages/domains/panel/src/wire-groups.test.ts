import { describe, expect, it } from 'vitest';
import { EVENT_PROPERTY_KEY, groupTypeOfProperty, parseEventBatch, parseServerBatch } from './wire';

const TS = '2026-10-27T12:00:00.000Z';
const event = (overrides: Record<string, unknown> = {}) => ({ event_id: 'evt_00000001', name: '$pageview', ts: TS, url: 'https://shop.example.com/', ...overrides });
const batch = (extra: Record<string, unknown> = {}) => ({
  token: 'wpk_0123456789abcdef0123456789abcdef',
  sent_at: TS,
  lib: 'web',
  lib_version: '0.3.0',
  consent: false,
  events: [event()],
  ...extra,
});

describe('groups, mobile and the new reserved keys', () => {
  it('reads group operations one by one, dropping only the invalid ones', () => {
    const parsed = parseEventBatch(
      batch({
        groups: [
          { op: 'set', type: 'company', key: 'acme', props: { $name: 'Acme', plan: 'pro' } },
          { op: 'set_once', type: 'company', key: 'acme', props: { founded: 1999 } },
          { op: 'unset', type: 'company', key: 'acme', keys: ['plan'] },
          { op: 'set', type: 'Company', key: 'acme', props: {} },
          { op: 'set', type: 'company', key: '', props: {} },
          { op: 'increment', type: 'company', key: 'acme', props: { n: 1 } },
        ],
      }),
    );
    expect(parsed.ok && parsed.batch.groups?.map((op) => op.op)).toEqual(['set', 'set_once', 'unset']);
    expect(parsed.ok && parsed.groupsDropped).toBe(3);
  });

  it('refuses more than 50 group operations', () => {
    const op = { op: 'set', type: 'company', key: 'acme', props: {} };
    expect(parseEventBatch(batch({ groups: Array.from({ length: 51 }, () => op) })).ok).toBe(false);
  });

  it('accepts lib mobile and the new system events', () => {
    const names = ['$webvitals', '$screen', '$app_opened', '$app_backgrounded', '$app_installed', '$app_updated'];
    const parsed = parseEventBatch(batch({ lib: 'mobile', events: names.map((name, i) => event({ name, event_id: `evt_0000000${i}`, url: 'app://com.acme.shop/Home' })) }));
    expect(parsed.ok && parsed.batch.events.map((e) => e.name)).toEqual(names);
    expect(parseEventBatch(batch({ lib: 'ios' })).ok).toBe(false);
  });

  it('accepts the reserved keys the SDKs set, and still refuses any other $ key', () => {
    for (const key of ['$initial_utm_source', '$initial_landing_path', '$group_company', '$lcp', '$cls_el', '$nav_type', '$screen_name', '$app_version', '$locale']) {
      expect(EVENT_PROPERTY_KEY.test(key), key).toBe(true);
    }
    for (const key of ['$action', '$group_Company', '$group_', '$initial_foo', '$app']) {
      expect(EVENT_PROPERTY_KEY.test(key), key).toBe(false);
    }
    expect(groupTypeOfProperty('$group_company')).toBe('company');
    expect(groupTypeOfProperty('group_company')).toBeNull();
  });

  it('accepts exactly the event property keys the Rust collector does', () => {
    // The Rust collector's PROPERTY_KEY (rust/modules/panel/src/collector/wire.rs), as one pattern.
    const rust =
      /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\$(?:source|line|col|from|initial_(?:referrer|referring_domain|utm_source|utm_medium|utm_campaign|utm_content|utm_term|landing_path)|group_[a-z][a-z0-9_]{0,31}|lcp|inp|fcp|ttfb|cls|lcp_el|inp_el|cls_el|nav_type|screen_name|os|os_version|device_type|device_model|app_id|app_version|app_build|screen_width|screen_height|locale))$/;
    const reserved = ['source', 'line', 'col', 'from', 'lcp', 'inp', 'fcp', 'ttfb', 'cls', 'lcp_el', 'inp_el', 'cls_el', 'nav_type'];
    const mobile = ['screen_name', 'os', 'os_version', 'device_type', 'device_model', 'app_id', 'app_version', 'app_build', 'screen_width', 'screen_height', 'locale'];
    const initial = ['referrer', 'referring_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'landing_path'];
    const names = [...reserved, ...mobile, ...initial.map((k) => `initial_${k}`), 'group_a', `group_a${'b'.repeat(31)}`];
    const keys = [
      ...names.flatMap((name) => [`$${name}`, name, `$${name}x`, `$${name}_`, `x$${name}`, `$$${name}`, ` $${name}`, `$${name} `, `$${name}\n`, `$${name.toUpperCase()}`]),
      // Plain identifiers: up to 64 characters, not starting with a digit.
      'a',
      '_',
      'A_1',
      '1a',
      'a'.repeat(64),
      'a'.repeat(65),
      'a-b',
      'é',
      '',
      // `$group_<type>`: a lower-case letter, then up to 31 of a-z, 0-9 and _.
      '$group_',
      '$group_1',
      '$group_A',
      '$group_a-b',
      `$group_a${'b'.repeat(32)}`,
      // Prefixes, partial names and keys of no SDK.
      '$',
      '$initial_',
      '$initial_utm',
      '$lcp_e',
      '$os_',
      '$app',
      '$action',
      '$constructor',
      '$__proto__',
    ];
    for (const key of keys) expect(EVENT_PROPERTY_KEY.test(key), JSON.stringify(key)).toBe(rust.test(key));

    // A refused key reads as a failed pattern check, as it did when the schema used `.regex()`.
    const refused = parseEventBatch(batch({ events: [event({ props: { $action: 1 } })] }));
    expect(refused.ok || refused.issues[0]).toEqual({ code: 'invalid_string', validation: 'regex', message: 'Invalid', path: ['events', 0, 'props', '$action'] });
  });

  it('takes a server batch with only group operations', () => {
    const parsed = parseServerBatch({ lib: 'server', lib_version: '0.3.0', groups: [{ op: 'set', type: 'company', key: 'acme', props: {} }] }, 100);
    expect(parsed.ok && parsed.batch.groups).toHaveLength(1);
    expect(parseServerBatch({ lib: 'server', lib_version: '0.3.0', groups: [{ op: 'set', type: 'BAD', key: 'acme', props: {} }] }, 100).ok).toBe(false);
  });
});
