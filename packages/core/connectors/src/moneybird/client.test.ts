import { describe, it, expect } from 'vitest';
import { ConnectorApiError } from '../types';
import { MoneybirdClient } from './client';

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

describe('MoneybirdClient', () => {
  it('lists contacts with updated_after and follows Link pagination', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse([{ id: 'c1', company_name: 'Acme' }], {
        headers: { link: '<https://moneybird.com/api/v2/123/contacts.json?page=2>; rel="next"' },
      });
    };
    const client = new MoneybirdClient(
      { accessToken: 'tok', administrationId: '123' },
      { fetchImpl },
    );
    const page = await client.listContacts({ updatedAfter: '2026-01-01T00:00:00Z' });
    expect(page.items).toHaveLength(1);
    expect(page.done).toBe(false);
    expect(page.nextCursor).toBe('2');
    expect(calls[0]).toContain('/api/v2/123/contacts.json');
    expect(calls[0]).toContain('filter=updated_after');
  });

  it('registers one webhook with enabled_events and returns the create-time secret', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { url?: string; enabled_events?: string[] };
      expect(body.url).toBe('https://hooks.example/webhooks/connectors/conn_1');
      expect(body.enabled_events).toContain('contact_created');
      return jsonResponse({
        id: 99,
        url: body.url,
        secret: 'only-once',
        enabled_events: body.enabled_events,
      });
    };
    const client = new MoneybirdClient(
      { accessToken: 'tok', administrationId: '123' },
      { fetchImpl },
    );
    const created = await client.registerWebhooks({
      deliveryUrl: 'https://hooks.example/webhooks/connectors/conn_1',
      secret: 'unused',
      topics: [
        { provider: 'moneybird', topic: 'contact_created', settingKey: 'contacts', kind: 'create' },
        { provider: 'moneybird', topic: 'contact_updated', settingKey: 'contacts', kind: 'update' },
      ],
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe('99');
    expect(created[0]?.secret).toBe('only-once');
  });

  it('deletes a webhook by id', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(null, { status: 204 });
    };
    const client = new MoneybirdClient(
      { accessToken: 'tok', administrationId: '123' },
      { fetchImpl },
    );
    await client.deleteWebhook('99');
    expect(calls[0]).toContain('DELETE');
    expect(calls[0]).toContain('/webhooks/99.json');
  });

  it('maps 401 to an auth error on test()', async () => {
    const fetchImpl: typeof fetch = async () => new Response('denied', { status: 401 });
    const client = new MoneybirdClient(
      { accessToken: 'tok', administrationId: '123' },
      { fetchImpl },
    );
    const result = await client.test();
    expect(result.ok).toBe(false);
  });

  it('throws when listing without an administration id', async () => {
    const client = new MoneybirdClient({ accessToken: 'tok' }, { fetchImpl: async () => jsonResponse([]) });
    await expect(client.listContacts()).rejects.toBeInstanceOf(ConnectorApiError);
  });
});
