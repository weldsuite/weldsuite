import { describe, expect, it } from 'vitest';
import type { AuditLogStream } from '@weldsuite/core-api-client/schemas/audit-log-streams';
import {
  EMPTY_STREAM_FORM,
  buildStreamFormSchema,
  destinationHost,
  settingsFromValues,
  toCreateInput,
  toUpdateInput,
  valuesFromStream,
} from './log-streaming-form';

const copy = { nameRequired: 'name', urlRequired: 'url', authHeaderInvalid: 'header' };
const schema = buildStreamFormSchema(copy);

const stream: AuditLogStream = {
  id: 'als_1',
  name: 'Splunk',
  type: 'splunk_hec',
  url: 'https://splunk.example.com:8088/services/collector/event',
  hasToken: true,
  settings: { index: 'audit', host: 'weld' },
  status: 'active',
  cursorCreatedAt: null,
  lastDeliveredAt: null,
  lastAttemptAt: null,
  lastError: null,
  consecutiveFailures: 0,
  deliveredCount: 0,
  createdById: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('buildStreamFormSchema', () => {
  it('asks for a name and a URL', () => {
    const result = schema.safeParse(EMPTY_STREAM_FORM);
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining(['name', 'url']));
  });

  it('accepts a header name of letters, digits and hyphens, or none', () => {
    const base = { ...EMPTY_STREAM_FORM, name: 'n', url: 'https://x.example.com' };
    expect(schema.safeParse({ ...base, authHeader: 'X-Api-Key' }).success).toBe(true);
    expect(schema.safeParse({ ...base, authHeader: '' }).success).toBe(true);
    expect(schema.safeParse({ ...base, authHeader: 'Not valid' }).success).toBe(false);
  });
});

describe('toCreateInput', () => {
  it('sends the Splunk settings that are filled in, and no HTTP ones', () => {
    const input = toCreateInput({
      ...EMPTY_STREAM_FORM,
      name: ' Splunk ',
      url: ' https://splunk.example.com:8088/services/collector/event ',
      token: 'hec-token',
      index: 'audit',
      source: ' ',
      authHeader: 'X-Ignored',
      format: 'ndjson',
    });
    expect(input).toEqual({
      name: 'Splunk',
      type: 'splunk_hec',
      url: 'https://splunk.example.com:8088/services/collector/event',
      token: 'hec-token',
      settings: { index: 'audit' },
    });
  });

  it('sends the HTTP header and format, no token when there is none, and no settings when all are default', () => {
    expect(
      toCreateInput({ ...EMPTY_STREAM_FORM, name: 'Collector', type: 'http', url: 'https://logs.example.com', authHeader: 'X-Api-Key', format: 'ndjson', index: 'ignored' }),
    ).toEqual({
      name: 'Collector',
      type: 'http',
      url: 'https://logs.example.com',
      settings: { authHeader: 'X-Api-Key', format: 'ndjson' },
    });
    expect(toCreateInput({ ...EMPTY_STREAM_FORM, name: 'Plain', type: 'http', url: 'https://logs.example.com' })).toEqual({
      name: 'Plain',
      type: 'http',
      url: 'https://logs.example.com',
    });
  });
});

describe('toUpdateInput', () => {
  const values = valuesFromStream(stream);

  it('never prefills the token', () => {
    expect(values.token).toBe('');
  });

  it('leaves the token out when it is kept', () => {
    const input = toUpdateInput(values, 'keep');
    expect('token' in input).toBe(false);
    expect(input.settings).toEqual({ index: 'audit', host: 'weld' });
  });

  it('also leaves it out when replacing with nothing typed', () => {
    expect('token' in toUpdateInput(values, 'replace')).toBe(false);
  });

  it('sends a typed token to replace it, and null to remove it', () => {
    expect(toUpdateInput({ ...values, token: 'new' }, 'replace').token).toBe('new');
    expect(toUpdateInput(values, 'remove').token).toBeNull();
  });

  it('clears the settings with null when none are left', () => {
    expect(toUpdateInput({ ...values, index: '', host: '' }, 'keep').settings).toBeNull();
  });
});

describe('helpers', () => {
  it('reads an HTTP stream back into the form', () => {
    const values = valuesFromStream({ ...stream, type: 'http', settings: { authHeader: 'X-Key', format: 'ndjson' } });
    expect(values).toMatchObject({ type: 'http', authHeader: 'X-Key', format: 'ndjson', index: '' });
    expect(settingsFromValues(values)).toEqual({ authHeader: 'X-Key', format: 'ndjson' });
  });

  it('shows only the host of a destination', () => {
    expect(destinationHost('https://splunk.example.com:8088/services/collector/event')).toBe('splunk.example.com:8088');
    expect(destinationHost('not a url')).toBe('');
  });
});
