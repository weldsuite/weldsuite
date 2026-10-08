import { beforeAll, describe, expect, it } from 'vitest';
import { WebhookVerificationError } from '../errors';
import { fromBase64Url, utf8 } from '../http';
import { jsonResponse, routeFetch } from '../test-utils';
import { createEnableBankingProvider, mapEnableBankingTransaction } from './provider';

// Shapes follow Enable Banking's documented API (hand-written fixtures, not recorded).
let privateKeyPem = '';
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const base64 = btoa(String.fromCharCode(...der));
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`;
  publicKey = pair.publicKey;
});

const NL_ASPSPS = { aspsps: [{ name: 'ING', country: 'NL', maximum_consent_validity: 15_552_000, logo: 'https://logo/ing.png' }, { name: 'Rabobank', country: 'NL', maximum_consent_validity: 7_776_000 }] };

function provider(routes: Parameters<typeof routeFetch>[0]) {
  const { fetch, calls } = routeFetch(routes);
  return { provider: createEnableBankingProvider({ appId: 'app-1', privateKey: privateKeyPem, fetch }), calls };
}

const stored = {
  provider: 'enable_banking',
  providerConnectionId: 'sess_1',
  credentials: { sessionId: 'sess_1' },
  cursor: null,
  metadata: { accountIds: ['uid_1'] },
  historyDays: 90,
};

describe('Enable Banking auth', () => {
  it('signs every call with an RS256 app JWT carrying the app id as kid', async () => {
    const { provider: p, calls } = provider({ 'GET /aspsps': NL_ASPSPS });
    await p.listInstitutions?.('nl');

    const jwt = calls[0]?.headers.authorization?.replace('Bearer ', '') ?? '';
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(header ?? '')))).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-1' });
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims ?? '')))).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com' });
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, fromBase64Url(signature ?? ''), utf8(`${header}.${claims}`));
    expect(valid).toBe(true);
    expect(calls[0]?.query.get('country')).toBe('NL');
  });
});

describe('Enable Banking link', () => {
  it('lists banks for a country', async () => {
    const { provider: p } = provider({ 'GET /aspsps': NL_ASPSPS });
    expect(await p.listInstitutions?.('NL')).toEqual([
      { id: 'ING', name: 'ING', country: 'NL', logoUrl: 'https://logo/ing.png' },
      { id: 'Rabobank', name: 'Rabobank', country: 'NL', logoUrl: null },
    ]);
  });

  it('needs the bank chosen up front, caps consent at the bank maximum, and returns the redirect', async () => {
    const { provider: p, calls } = provider({
      'GET /aspsps': NL_ASPSPS,
      'POST /auth': { url: 'https://bank.example/consent?x=1', authorization_id: 'auth_1' },
    });
    await expect(p.createLinkSession({ workspaceId: 'ws_1', mode: 'create', historyDays: 90, redirectUrl: 'https://app.example/cb' })).rejects.toThrow(/bank/);

    const session = await p.createLinkSession({
      workspaceId: 'ws_1',
      mode: 'create',
      historyDays: 90,
      redirectUrl: 'https://app.example/cb',
      institution: { name: 'Rabobank', country: 'nl' },
    });

    expect(session).toEqual({ kind: 'redirect', url: 'https://bank.example/consent?x=1', sessionId: 'auth_1' });
    const auth = calls.find((c) => c.path === '/auth');
    expect(auth?.payload).toMatchObject({ aspsp: { name: 'Rabobank', country: 'NL' }, redirect_url: 'https://app.example/cb', psu_type: 'business' });
    const validUntil = Date.parse(String((auth?.payload.access as { valid_until: string }).valid_until));
    const days = Math.round((validUntil - Date.now()) / 86_400_000);
    expect(days).toBe(90); // Rabobank's maximum consent validity, below the 180 day PSD2 ceiling
  });

  it('turns the redirect code into a session with accounts matched by IBAN', async () => {
    const { provider: p, calls } = provider({
      'POST /sessions': {
        session_id: 'sess_1',
        aspsp: { name: 'ING', country: 'NL' },
        access: { valid_until: '2027-04-01T00:00:00Z' },
        accounts: [
          { uid: 'uid_1', account_id: { iban: 'NL91ABNA0417164300' }, name: 'Zakelijk', cash_account_type: 'CACC', currency: 'EUR' },
          { uid: 'uid_2', account_id: { iban: 'NL02ABNA0123456789' }, name: 'Spaar', cash_account_type: 'SVGS', currency: 'EUR' },
        ],
      },
    });

    const { connection, accounts } = await p.completeLink({ code: 'redirect-code', state: 's' });

    expect(calls[0]?.payload).toEqual({ code: 'redirect-code' });
    expect(connection).toMatchObject({
      providerConnectionId: 'sess_1',
      institutionName: 'ING',
      consentExpiresAt: '2027-04-01T00:00:00Z',
      credentials: { sessionId: 'sess_1' },
      metadata: { accountIds: ['uid_1', 'uid_2'] },
    });
    expect(accounts[0]).toMatchObject({ providerAccountId: 'uid_1', iban: 'NL91ABNA0417164300', type: 'depository', subtype: 'checking', mask: '4300' });
    expect(accounts[1]?.subtype).toBe('savings');
    expect(accounts[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Enable Banking sync', () => {
  it('pulls the date window with the continuation key and signs amounts by direction', async () => {
    const { provider: p, calls } = provider({
      'GET /accounts/uid_1/transactions': (call) =>
        call.query.get('continuation_key')
          ? { transactions: [{ entry_reference: 'e3', transaction_amount: { currency: 'EUR', amount: '5.00' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-02', remittance_information: ['Koffie'] }], continuation_key: null }
          : {
              transactions: [
                { entry_reference: 'e1', transaction_amount: { currency: 'EUR', amount: '125.40' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-05', creditor: { name: 'Leverancier BV' }, remittance_information: ['Factuur 77'] },
                { entry_reference: 'e2', transaction_amount: { currency: 'EUR', amount: '1000.00' }, credit_debit_indicator: 'CRDT', booking_date: '2026-10-04', debtor: { name: 'Klant NV' }, remittance_information: [] },
              ],
              continuation_key: 'next-1',
            },
    });

    const result = await p.syncTransactions(stored, { through: '2026-10-06' });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query.get('date_from')).toBe('2026-09-28'); // last through minus the 8 day re-pull
    expect(calls[0]?.query.get('strategy')).toBe('longest');
    expect(calls[1]?.query.get('continuation_key')).toBe('next-1');
    expect(result.upserts.map((t) => [t.providerTransactionId, t.amountMinor, t.merchantName])).toEqual([
      ['e1', -12540, 'Leverancier BV'],
      ['e2', 100000, 'Klant NV'],
      ['e3', -500, null],
    ]);
    expect(result.upserts[0]?.description).toBe('Factuur 77');
    expect(result.nextCursor).toEqual({ through: new Date().toISOString().slice(0, 10) });
    expect(result.removals).toEqual([]);
  });

  it('derives stable ids for banks that send none, numbering identical twins', async () => {
    const raw = { transaction_amount: { currency: 'EUR', amount: '3.50' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-05', remittance_information: ['Parkeren'] };
    const seen = new Map<string, number>();
    const a = await mapEnableBankingTransaction(raw, 'uid_1', seen);
    const b = await mapEnableBankingTransaction(raw, 'uid_1', seen);
    const again = await mapEnableBankingTransaction(raw, 'uid_1', new Map());
    expect(a?.providerTransactionId).toMatch(/^eb_[0-9a-f]{40}$/);
    expect(b?.providerTransactionId).not.toBe(a?.providerTransactionId);
    expect(again?.providerTransactionId).toBe(a?.providerTransactionId);
  });

  it('treats a dead session as reauth_required', async () => {
    const { provider: p } = provider({ 'GET /accounts/uid_1/transactions': () => jsonResponse(401, { message: 'Session has expired' }) });
    await expect(p.syncTransactions(stored, null)).rejects.toMatchObject({ kind: 'reauth_required' });
  });
});

describe('Enable Banking balances, disconnect, webhooks', () => {
  it('prefers the closing booked balance and signs debit balances', async () => {
    const { provider: p } = provider({
      'GET /accounts/uid_1/balances': {
        balances: [
          { balance_type: 'ITBD', balance_amount: { currency: 'EUR', amount: '90.00' } },
          { balance_type: 'CLBD', balance_amount: { currency: 'EUR', amount: '120.55' }, reference_date: '2026-10-07' },
        ],
      },
    });
    expect((await p.getBalances(stored))[0]).toMatchObject({ accountId: 'uid_1', current: 12055, currency: 'EUR', asOf: '2026-10-07T00:00:00.000Z' });
  });

  it('deletes the session and refuses webhooks', async () => {
    const { provider: p, calls } = provider({ 'DELETE /sessions/sess_1': {} });
    await p.disconnect(stored);
    expect(calls[0]?.method).toBe('DELETE');
    await expect(p.parseWebhook(new Request('https://x', { method: 'POST', body: '{}' }), {})).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(p.capabilities).toMatchObject({ changeCursor: false, webhooks: false, consentTtlDays: 180 });
  });
});
