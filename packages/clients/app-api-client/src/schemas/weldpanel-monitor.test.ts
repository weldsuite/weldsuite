import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  createPanelAlertSchema,
  createPanelDomainSchema,
  createPanelExportSchema,
  createPanelSubscriptionSchema,
  isHostname,
  isPublicHostname,
  isSlackWebhookUrl,
  isTimeZone,
  PANEL_MAX_EMAIL_RECIPIENTS,
  panelAlertConditionSchema,
  panelDeliveryChannelsInputSchema,
  panelExportDestinationSchema,
  panelSubscriptionScheduleSchema,
  snoozePanelAlertSchema,
  testPanelExportSchema,
  updatePanelAlertSchema,
  updatePanelExportSchema,
  updatePanelSubscriptionSchema,
} from './weldpanel-monitor';

/** The issues a parse reports, as `path: message`. Empty when it parses. */
function issuesOf(schema: ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const projectId = 'pnp_1';
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const TRENDS = { kind: 'trends', projectId, series: [{ event: 'Signed up' }] };

describe('Slack webhook URLs', () => {
  it('accepts an incoming webhook on hooks.slack.com', () => {
    expect(isSlackWebhookUrl(SLACK)).toBe(true);
  });

  it.each([
    ['plain http', 'http://hooks.slack.com/services/T000'],
    ['another host', 'https://hooks.slack.com.evil.example/services'],
    ['a look-alike prefix', 'https://hooks.slack.co/services/T000'],
    ['no path', 'https://hooks.slack.com/'],
  ])('refuses %s', (_name, url) => {
    expect(isSlackWebhookUrl(url)).toBe(false);
  });
});

describe('delivery channels', () => {
  it('defaults to nobody, and removes duplicate recipients', () => {
    expect(panelDeliveryChannelsInputSchema.parse({})).toEqual({ emailUserIds: [], inApp: false });
    expect(panelDeliveryChannelsInputSchema.parse({ emailUserIds: ['u_1', 'u_2', 'u_1'], inApp: true })).toEqual({
      emailUserIds: ['u_1', 'u_2'],
      inApp: true,
    });
  });

  it('sets, clears or keeps the Slack webhook', () => {
    expect(panelDeliveryChannelsInputSchema.parse({ slackWebhookUrl: SLACK }).slackWebhookUrl).toBe(SLACK);
    expect(panelDeliveryChannelsInputSchema.parse({ slackWebhookUrl: null }).slackWebhookUrl).toBeNull();
    expect(panelDeliveryChannelsInputSchema.parse({})).not.toHaveProperty('slackWebhookUrl');
    expect(issuesOf(panelDeliveryChannelsInputSchema, { slackWebhookUrl: 'https://example.com/hook' })).toEqual([
      'slackWebhookUrl: Use a Slack incoming webhook URL (https://hooks.slack.com/…)',
    ]);
  });

  it(`emails at most ${PANEL_MAX_EMAIL_RECIPIENTS} members`, () => {
    const ids = Array.from({ length: PANEL_MAX_EMAIL_RECIPIENTS + 1 }, (_, i) => `u_${i}`);
    expect(panelDeliveryChannelsInputSchema.safeParse({ emailUserIds: ids }).success).toBe(false);
  });
});

describe('alert conditions', () => {
  it('reads threshold, change and anomaly conditions', () => {
    expect(panelAlertConditionSchema.parse({ type: 'threshold', operator: 'below', value: 0 })).toEqual({ type: 'threshold', operator: 'below', value: 0 });
    expect(panelAlertConditionSchema.parse({ type: 'change', direction: 'any', percent: 25 })).toEqual({ type: 'change', direction: 'any', percent: 25 });
    expect(panelAlertConditionSchema.parse({ type: 'anomaly', sensitivity: 'high' })).toEqual({ type: 'anomaly', sensitivity: 'high' });
  });

  it('refuses a change of zero percent and an unknown type', () => {
    expect(panelAlertConditionSchema.safeParse({ type: 'change', direction: 'any', percent: 0 }).success).toBe(false);
    expect(panelAlertConditionSchema.safeParse({ type: 'forecast' }).success).toBe(false);
  });
});

describe('alerts', () => {
  const alert = { projectId, name: 'Sign-ups', condition: { type: 'anomaly', sensitivity: 'medium' }, channels: {} };

  it('watches a saved report with the defaults filled in', () => {
    expect(createPanelAlertSchema.parse({ ...alert, reportId: 'pnr_1' })).toMatchObject({
      reportId: 'pnr_1',
      seriesIndex: 0,
      checkInterval: 'daily',
      enabled: true,
      channels: { emailUserIds: [], inApp: false },
    });
  });

  it('watches a spec of its own', () => {
    expect(createPanelAlertSchema.parse({ ...alert, spec: TRENDS, seriesIndex: 0 }).spec).toMatchObject({ kind: 'trends', projectId });
  });

  it('needs either a report or a spec, not both', () => {
    expect(issuesOf(createPanelAlertSchema, alert)).toEqual(['reportId: Give either a report or a spec']);
    expect(issuesOf(createPanelAlertSchema, { ...alert, reportId: 'pnr_1', spec: TRENDS })).toEqual(['reportId: Give either a report or a spec']);
    expect(issuesOf(createPanelAlertSchema, { ...alert, reportId: null, spec: null })).toEqual(['reportId: Give either a report or a spec']);
  });

  it('updates any field, but never to a report and a spec at once', () => {
    expect(updatePanelAlertSchema.parse({})).toEqual({});
    expect(updatePanelAlertSchema.parse({ spec: TRENDS, reportId: null })).toMatchObject({ reportId: null });
    expect(issuesOf(updatePanelAlertSchema, { reportId: 'pnr_1', spec: TRENDS })).toEqual(['reportId: Give either a report or a spec']);
    expect(updatePanelAlertSchema.safeParse({ seriesIndex: 5 }).success).toBe(false);
  });

  it('snoozes until a moment, or ends the snooze', () => {
    expect(snoozePanelAlertSchema.parse({ until: '2026-12-01T00:00:00Z' })).toEqual({ until: '2026-12-01T00:00:00Z' });
    expect(snoozePanelAlertSchema.parse({ until: null })).toEqual({ until: null });
    expect(snoozePanelAlertSchema.safeParse({ until: '2026-12-01' }).success).toBe(false);
  });
});

describe('time zones', () => {
  it('knows IANA zones and refuses made-up ones', () => {
    expect(isTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('subscription schedules', () => {
  it('sends daily in UTC unless told otherwise', () => {
    expect(panelSubscriptionScheduleSchema.parse({ frequency: 'daily', hour: 8 })).toEqual({ frequency: 'daily', hour: 8, timezone: 'UTC' });
  });

  it('needs a weekday for weekly and a day of the month for monthly', () => {
    expect(issuesOf(panelSubscriptionScheduleSchema, { frequency: 'weekly', hour: 8 })).toEqual(['weekday: Choose a weekday']);
    expect(issuesOf(panelSubscriptionScheduleSchema, { frequency: 'monthly', hour: 8 })).toEqual(['monthDay: Choose a day of the month']);
    expect(panelSubscriptionScheduleSchema.safeParse({ frequency: 'weekly', hour: 8, weekday: 1, timezone: 'Europe/Amsterdam' }).success).toBe(true);
    expect(panelSubscriptionScheduleSchema.safeParse({ frequency: 'monthly', hour: 8, monthDay: 28 }).success).toBe(true);
    expect(panelSubscriptionScheduleSchema.safeParse({ frequency: 'monthly', hour: 8, monthDay: 31 }).success).toBe(false);
  });

  it('refuses an unknown timezone', () => {
    expect(issuesOf(panelSubscriptionScheduleSchema, { frequency: 'daily', hour: 8, timezone: 'Nowhere/Land' })).toEqual([
      'timezone: Unknown timezone',
    ]);
  });
});

describe('subscriptions', () => {
  it('creates an enabled subscription to a report or dashboard', () => {
    expect(
      createPanelSubscriptionSchema.parse({
        projectId,
        name: 'Monday numbers',
        targetType: 'dashboard',
        targetId: 'pnd_1',
        schedule: { frequency: 'weekly', hour: 9, weekday: 1 },
        channels: { weldchatChannelId: 'ch_1' },
      }),
    ).toMatchObject({ enabled: true, schedule: { timezone: 'UTC' }, channels: { weldchatChannelId: 'ch_1' } });
  });

  it('updates any field', () => {
    expect(updatePanelSubscriptionSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updatePanelSubscriptionSchema.safeParse({ schedule: { frequency: 'weekly', hour: 9 } }).success).toBe(false);
  });
});

describe('public host names', () => {
  it.each(['storage.googleapis.com', 'abc.r2.cloudflarestorage.com', 'S3.EU-WEST-1.amazonaws.com.'])('allows %s', (host) => {
    expect(isPublicHostname(host)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a single label', 'minio'],
    ['an IPv6 literal', '[::1]'],
    ['a port', 'example.com:9000'],
    ['an IPv4 literal', '10.0.0.1'],
    ['localhost', 'localhost'],
    ['WeldSuite itself', 'weldsuite.org'],
    ['a WeldSuite host', 'panel-api.weldsuite.org'],
    ['a .local name', 'nas.local'],
    ['an .internal name', 'minio.corp.internal'],
    ['a .localhost name', 'app.localhost'],
  ])('refuses %s', (_name, host) => {
    expect(isPublicHostname(host)).toBe(false);
  });
});

describe('export destinations', () => {
  const s3 = { provider: 's3', region: 'eu-west-1', bucket: 'panel-exports', accessKeyId: 'AKIAEXAMPLE' };
  const r2 = { ...s3, provider: 'r2', region: 'auto' };

  it('needs only the region and bucket for AWS S3', () => {
    expect(panelExportDestinationSchema.parse(s3)).toEqual({ ...s3, endpoint: null, prefix: '', pathStyle: false });
  });

  it('keeps the endpoint without its trailing slash, and the prefix without its outer slashes', () => {
    expect(
      panelExportDestinationSchema.parse({ ...r2, endpoint: 'https://abc.r2.cloudflarestorage.com/', prefix: ' /weldpanel/raw/ ', pathStyle: true }),
    ).toEqual({ ...r2, endpoint: 'https://abc.r2.cloudflarestorage.com', prefix: 'weldpanel/raw', pathStyle: true });
  });

  it('needs the endpoint of any other provider', () => {
    expect(issuesOf(panelExportDestinationSchema, r2)).toEqual(['endpoint: This provider needs its endpoint']);
    expect(issuesOf(panelExportDestinationSchema, { ...r2, endpoint: null })).toEqual(['endpoint: This provider needs its endpoint']);
  });

  it.each([
    ['plain http', 'http://minio.example.com'],
    ['a user name', 'https://user@minio.example.com'],
    ['a path', 'https://minio.example.com/bucket'],
    ['a query', 'https://minio.example.com/?region=x'],
    ['a fragment', 'https://minio.example.com/#top'],
    ['an IP address', 'https://192.168.1.10'],
    ['a private host', 'https://minio.lan'],
    ['something that is not a URL', 'minio.example.com'],
  ])('refuses an endpoint with %s', (_name, endpoint) => {
    expect(issuesOf(panelExportDestinationSchema, { ...r2, provider: 'minio', endpoint })).toContain(
      'endpoint: Use an https:// origin without a path',
    );
  });

  it('checks the region, bucket and prefix', () => {
    expect(issuesOf(panelExportDestinationSchema, { ...s3, region: 'eu west' })).toEqual(['region: Not a valid region']);
    expect(issuesOf(panelExportDestinationSchema, { ...s3, bucket: 'Panel_Exports' })).toEqual(['bucket: Not a valid bucket name']);
    expect(issuesOf(panelExportDestinationSchema, { ...s3, prefix: 'raw data' })).toEqual([
      "prefix: Use letters, digits and / - _ . ! * ' ( ) only",
    ]);
  });
});

describe('exports', () => {
  const destination = { provider: 's3', region: 'eu-west-1', bucket: 'panel-exports', accessKeyId: 'AKIAEXAMPLE' };

  it('creates a daily export of each table once', () => {
    expect(
      createPanelExportSchema.parse({ projectId, name: 'Raw', destination, secretAccessKey: 'test-secret', tables: ['events', 'people', 'events'] }),
    ).toMatchObject({ tables: ['events', 'people'], frequency: 'daily' });
    expect(createPanelExportSchema.safeParse({ projectId, name: 'Raw', destination, secretAccessKey: 'test-secret', tables: [] }).success).toBe(false);
  });

  it('updates any field', () => {
    expect(updatePanelExportSchema.parse({ tables: ['groups', 'groups'] })).toEqual({ tables: ['groups'] });
    expect(updatePanelExportSchema.parse({})).toEqual({});
  });

  it('tests a saved export, or a new destination with its project and secret', () => {
    expect(testPanelExportSchema.safeParse({ exportId: 'pnx_1' }).success).toBe(true);
    expect(testPanelExportSchema.safeParse({ projectId, destination, secretAccessKey: 'test-secret' }).success).toBe(true);
    expect(issuesOf(testPanelExportSchema, { projectId, destination })).toEqual([
      ': Send a saved export, or a project, destination and secret key',
    ]);
  });
});

describe('collector host names', () => {
  it('accepts DNS names with a letters-only top level', () => {
    expect(isHostname('stats.example.com')).toBe(true);
    expect(isHostname('a.bc')).toBe(true);
    expect(isHostname('my-stats.example.co.uk')).toBe(true);
  });

  it.each([
    ['too short', 'a.b'],
    ['too long', `${'a'.repeat(250)}.com`],
    ['one label', 'localhost'],
    ['a numeric top level', 'example.c0m'],
    ['an empty label', 'stats..example.com'],
    ['a leading hyphen', '-stats.example.com'],
    ['a trailing hyphen', 'stats-.example.com'],
    ['upper case', 'Stats.example.com'],
  ])('refuses %s', (_name, value) => {
    expect(isHostname(value)).toBe(false);
  });

  it('lower-cases and trims the host name, and refuses WeldSuite hosts', () => {
    expect(createPanelDomainSchema.parse({ hostname: '  Stats.Example.COM ' })).toEqual({ hostname: 'stats.example.com' });
    expect(issuesOf(createPanelDomainSchema, { hostname: 'weldsuite.org' })).toEqual(['hostname: Use a host name of your own']);
    expect(issuesOf(createPanelDomainSchema, { hostname: 'stats.weldsuite.org' })).toEqual(['hostname: Use a host name of your own']);
    expect(issuesOf(createPanelDomainSchema, { hostname: 'stats' })).toEqual(['hostname: Enter a host name like stats.example.com']);
  });
});
