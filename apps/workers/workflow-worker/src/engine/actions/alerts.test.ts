/**
 * parse_alert: realistic Splunk, Datadog and Grafana payloads, the generic
 * fallback, and input that is not an alert at all.
 */

import { describe, expect, it } from 'vitest';
import { makeActionContext } from '../../test/ctx';
import { fitExternalId, handleParseAlert, parseAlert, severityToPriority } from './alerts';

const GRAFANA_FIRING = {
  receiver: 'weldsuite',
  status: 'firing',
  orgId: 1,
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'HighCPU', instance: 'web-1', severity: 'critical' },
      annotations: { summary: 'CPU is above 90% on web-1' },
      startsAt: '2026-11-09T09:00:00Z',
      generatorURL: 'https://grafana.example.com/alerting/grafana/abc/view',
      fingerprint: 'c0ffee',
    },
  ],
  groupLabels: { alertname: 'HighCPU' },
  commonLabels: { alertname: 'HighCPU', severity: 'critical' },
  commonAnnotations: { summary: 'CPU is above 90% on web-1' },
  externalURL: 'https://grafana.example.com/',
  groupKey: '{}:{alertname="HighCPU"}',
  title: '[FIRING:1] HighCPU web-1',
  message: '**Firing**\n\nCPU is above 90% on web-1',
};

const DATADOG = {
  id: '5000000001',
  title: '[Triggered on {host:db-1}] Disk space is low',
  body: 'Disk usage is above 90% on db-1',
  alert_id: '7771',
  alert_title: 'Disk space is low on db-1',
  alert_transition: 'Triggered',
  alert_type: 'error',
  alert_priority: 'P1',
  aggreg_key: 'abcdef',
  link: 'https://app.datadoghq.com/monitors/7771',
};

const SPLUNK = {
  sid: 'scheduler__admin__search__RMD5f_at_1',
  search_name: 'Failed logins',
  app: 'search',
  owner: 'admin',
  results_link: 'https://splunk.example.com:8000/app/search/@go?sid=scheduler__admin',
  result: { host: 'auth-1', count: '41', severity: 'Warning' },
};

describe('parseAlert: Grafana', () => {
  it('reads a firing alert', () => {
    expect(parseAlert(GRAFANA_FIRING)).toEqual({
      success: true,
      source: 'grafana',
      externalId: 'grafana:{}:{alertname="HighCPU"}',
      title: '[FIRING:1] HighCPU web-1',
      message: '**Firing**\n\nCPU is above 90% on web-1\n\nhttps://grafana.example.com/alerting/grafana/abc/view',
      severity: 'critical',
      priority: 'urgent',
      state: 'open',
      resolved: false,
      url: 'https://grafana.example.com/alerting/grafana/abc/view',
      tags: ['grafana', 'alert'],
    });
  });

  it('closes on the same external id when the alert resolves', () => {
    const firing = parseAlert(GRAFANA_FIRING);
    const resolved = parseAlert({ ...GRAFANA_FIRING, status: 'resolved', title: '[RESOLVED] HighCPU web-1' });
    expect(resolved).toMatchObject({ state: 'closed', resolved: true });
    expect(resolved.success && firing.success && resolved.externalId === firing.externalId).toBe(true);
  });

  it('falls back to the fingerprint and the first alert label', () => {
    const { groupKey: _groupKey, commonLabels: _commonLabels, ...rest } = GRAFANA_FIRING;
    expect(parseAlert({ ...rest, alerts: [{ ...GRAFANA_FIRING.alerts[0], labels: { severity: 'warning' } }] })).toMatchObject({
      externalId: 'grafana:c0ffee',
      priority: 'medium',
    });
  });
});

describe('parseAlert: Datadog', () => {
  it('reads a triggered monitor', () => {
    expect(parseAlert(DATADOG)).toEqual({
      success: true,
      source: 'datadog',
      externalId: 'datadog:abcdef',
      title: 'Disk space is low on db-1',
      message: 'Disk usage is above 90% on db-1\n\nhttps://app.datadoghq.com/monitors/7771',
      severity: 'P1',
      priority: 'urgent',
      state: 'open',
      resolved: false,
      url: 'https://app.datadoghq.com/monitors/7771',
      tags: ['datadog', 'alert'],
    });
  });

  it('resolves on a Recovered transition, in any case', () => {
    expect(parseAlert({ ...DATADOG, alert_transition: 'RECOVERED' })).toMatchObject({ state: 'closed', resolved: true });
  });

  it('resolves on alert_type success', () => {
    expect(parseAlert({ ...DATADOG, alert_type: 'success', alert_priority: undefined })).toMatchObject({
      resolved: true,
      priority: 'medium',
    });
  });

  it('takes the severity from alert_type without a priority, and the id from aggreg_key', () => {
    const { alert_priority: _priority, alert_id: _id, ...rest } = DATADOG;
    expect(parseAlert({ ...rest, alert_type: 'warning' })).toMatchObject({
      externalId: 'datadog:abcdef',
      severity: 'warning',
      priority: 'medium',
    });
  });

  describe('external id', () => {
    const MULTI = { alert_id: '7771', alert_transition: 'Triggered', alert_title: 'CPU high' };
    const idOf = (payload: Record<string, unknown>) => {
      const parsed = parseAlert(payload);
      if (!parsed.success) throw new Error(parsed.error);
      return parsed.externalId;
    };

    it('prefers aggreg_key, which Datadog sets per group', () => {
      expect(idOf({ ...MULTI, aggreg_key: 'g1', alert_scope: 'host:a' })).toBe('datadog:g1');
    });

    it('gives each group of a multi-alert monitor its own id', () => {
      const a = idOf({ ...MULTI, alert_scope: 'host:a' });
      const b = idOf({ ...MULTI, alert_scope: 'host:b' });
      expect(a).toBe('datadog:7771:host:a');
      expect(b).not.toBe(a);
    });

    it('keeps a firing and its recovery on one id, whatever the order of the scope tags', () => {
      const firing = idOf({ ...MULTI, alert_scope: 'host:a,env:prod' });
      const recovered = idOf({ ...MULTI, alert_transition: 'Recovered', alert_type: 'success', alert_scope: ' env:prod, host:a' });
      expect(recovered).toBe(firing);
      expect(firing).toBe('datadog:7771:env:prod,host:a');
    });

    it('reads the group from scope when alert_scope is absent', () => {
      expect(idOf({ ...MULTI, scope: 'host:a' })).toBe('datadog:7771:host:a');
      expect(idOf({ ...MULTI, alert_scope: 'host:a', scope: 'host:b' })).toBe('datadog:7771:host:a');
    });

    it('falls back to alert_id alone, then id', () => {
      expect(idOf(MULTI)).toBe('datadog:7771');
      expect(idOf({ id: '900', alert_transition: 'Triggered', alert_scope: 'host:a' })).toBe('datadog:900');
    });

    it('ignores tags, which are too noisy to key on', () => {
      expect(idOf({ ...MULTI, tags: 'host:a,env:prod' })).toBe('datadog:7771');
    });

    it('stays within the 255 characters the column takes, deterministically and distinctly', () => {
      const long = (suffix: string) => idOf({ ...MULTI, alert_scope: `host:${'x'.repeat(400)}${suffix}` });
      const a = long('a');
      expect(Array.from(a)).toHaveLength(255);
      expect(long('a')).toBe(a);
      expect(long('b')).not.toBe(a);
      expect(a.startsWith('datadog:7771:host:xxx')).toBe(true);
    });
  });

  it('keeps Warn and No Data open', () => {
    expect(parseAlert({ ...DATADOG, alert_transition: 'Warn' })).toMatchObject({ state: 'open' });
    expect(parseAlert({ ...DATADOG, alert_transition: 'No Data' })).toMatchObject({ state: 'open' });
  });
});

describe('parseAlert: Splunk', () => {
  it('reads an alert action', () => {
    expect(parseAlert(SPLUNK)).toEqual({
      success: true,
      source: 'splunk',
      externalId: 'splunk:Failed logins',
      title: 'Failed logins',
      message: [
        'Splunk alert "Failed logins" fired.',
        'app search, owner admin',
        'count: 41',
        'host: auth-1',
        'severity: Warning',
        '',
        SPLUNK.results_link,
      ].join('\n'),
      severity: 'Warning',
      priority: 'medium',
      state: 'open',
      resolved: false,
      url: SPLUNK.results_link,
      tags: ['splunk', 'alert'],
    });
  });

  it('uses urgency when the result has no severity, and is never resolved', () => {
    expect(parseAlert({ ...SPLUNK, result: { urgency: 'High' }, status: 'resolved' })).toMatchObject({
      priority: 'high',
      state: 'open',
    });
  });

  it('uses the default priority when the result carries no severity', () => {
    expect(parseAlert({ ...SPLUNK, result: { host: 'a' } }, 'auto', 'high')).toMatchObject({ severity: '', priority: 'high' });
  });
});

describe('parseAlert: detection and generic payloads', () => {
  it('an explicit source wins over detection', () => {
    expect(parseAlert({ ...DATADOG, search_name: 'x', sid: '1' }, 'datadog')).toMatchObject({ source: 'datadog' });
    expect(parseAlert({ ...DATADOG, search_name: 'x', sid: '1' }, 'splunk')).toMatchObject({ source: 'splunk' });
  });

  it('reads a generic alert, with the id from id, then externalId, then fingerprint', () => {
    expect(
      parseAlert({ externalId: 'inc-9', summary: 'Queue backed up', description: 'Depth 5k', level: 'Major', status: 'ok', link: 'https://x.test/1' }),
    ).toMatchObject({
      source: 'generic',
      externalId: 'generic:inc-9',
      title: 'Queue backed up',
      priority: 'high',
      state: 'closed',
      tags: ['generic', 'alert'],
    });
    expect(parseAlert({ fingerprint: 'fp', name: 'N' })).toMatchObject({ externalId: 'generic:fp' });
  });

  it('keys an id-less alert on its title', () => {
    expect(parseAlert({ title: 'Cert expires soon' })).toMatchObject({
      externalId: 'generic:Cert expires soon',
      message: 'Cert expires soon',
    });
  });

  it('titles an alert that only has an id', () => {
    expect(parseAlert({ id: 42 })).toMatchObject({ title: 'generic alert 42', externalId: 'generic:42' });
  });

  it('accepts a JSON string payload', () => {
    expect(parseAlert(JSON.stringify(DATADOG))).toMatchObject({ source: 'datadog', externalId: 'datadog:abcdef' });
  });
});

describe('parseAlert: input that is not an alert', () => {
  it.each([null, undefined, 'not json', '[1,2]', '"text"', 42, true, [], [{ id: 1 }], {}, { foo: 'bar' }, { id: '', title: '  ' }])(
    'answers success false for %j',
    (payload) => {
      const result = parseAlert(payload);
      expect(result.success).toBe(false);
      expect(result).toHaveProperty('error');
    },
  );
});

describe('fitExternalId', () => {
  it('leaves a key of up to 255 characters alone', () => {
    expect(fitExternalId('a'.repeat(255))).toBe('a'.repeat(255));
  });

  it('cuts by characters, not bytes, and ends in a hash of the whole key', () => {
    const fitted = fitExternalId('é'.repeat(300));
    expect(Array.from(fitted)).toHaveLength(255);
    expect(fitted).toMatch(/^é{246}~[0-9a-f]{8}$/);
  });
});

describe('severityToPriority', () => {
  it.each([
    ['critical', 'urgent'],
    ['FATAL', 'urgent'],
    ['Emergency', 'urgent'],
    ['disaster', 'urgent'],
    ['P1', 'urgent'],
    ['SEV-1', 'urgent'],
    ['high', 'high'],
    ['error', 'high'],
    ['Major', 'high'],
    ['p2', 'high'],
    ['sev 2', 'high'],
    ['warning', 'medium'],
    ['WARN', 'medium'],
    ['moderate', 'medium'],
    ['p3', 'medium'],
    ['sev3', 'medium'],
    ['low', 'low'],
    ['info', 'low'],
    ['informational', 'low'],
    ['minor', 'low'],
    ['notice', 'low'],
    ['debug', 'low'],
    ['p4', 'low'],
    ['P5', 'low'],
    ['sev4', 'low'],
    ['sev5', 'low'],
  ])('%s is %s', (severity, priority) => {
    expect(severityToPriority(severity, 'medium')).toBe(priority);
  });

  it('uses the default for anything else', () => {
    expect(severityToPriority('', 'urgent')).toBe('urgent');
    expect(severityToPriority('purple', 'low')).toBe('low');
  });
});

describe('handleParseAlert', () => {
  it('reads the trigger body when no payload is given', async () => {
    const ctx = makeActionContext({ triggerData: { body: DATADOG } });
    expect(await handleParseAlert({}, ctx)).toMatchObject({ success: true, source: 'datadog' });
    expect(await handleParseAlert({ payload: '' }, ctx)).toMatchObject({ source: 'datadog' });
  });

  it('an explicit payload, source and default priority win', async () => {
    const ctx = makeActionContext({ triggerData: { body: DATADOG } });
    expect(await handleParseAlert({ payload: SPLUNK, source: 'splunk', defaultPriority: 'high' }, ctx)).toMatchObject({
      source: 'splunk',
    });
    expect(await handleParseAlert({ payload: { title: 'T' }, defaultPriority: 'urgent' }, ctx)).toMatchObject({
      priority: 'urgent',
    });
    expect(await handleParseAlert({ payload: { title: 'T' }, defaultPriority: 'bogus' }, ctx)).toMatchObject({
      priority: 'medium',
    });
  });

  it('answers success false without a payload or trigger body', async () => {
    expect(await handleParseAlert({}, makeActionContext())).toMatchObject({ success: false });
  });
});
