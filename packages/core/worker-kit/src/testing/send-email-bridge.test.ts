import { afterEach, describe, expect, it } from 'vitest';
import { sendRecord } from './mime-record';
import { createSendEmailStub, recordTypeScriptSends, sendEmailUrl, takeRustSends } from './send-email-bridge';
import { ledgerUrls, recordTypeScriptLedgerCalls, takeRustLedgerCalls } from './ledger-bridge';

const crlf = (lines: string[]) => lines.join('\r\n');

/** One message as mimetext (TypeScript, `buildRfc5322`) builds it. */
const MIMETEXT = crlf([
  'Date: Thu, 29 Oct 2026 14:16:27 +0000',
  'From: =?utf-8?B?VG9tIMOE?= <tom@acme.com>',
  'Reply-To: <r@acme.com>',
  'To: <a@x.com>,',
  ' <b@y.com>',
  'Cc: <c@z.com>',
  'Message-ID: <b5774fcdc14aa9d30a7c91be585024b8@acme.com>',
  'Subject: =?utf-8?B?SMOpbGxvIHRoZXJl?=',
  'MIME-Version: 1.0',
  'In-Reply-To: <p@x>',
  'References: <a@x> <p@x>',
  'Content-Type: multipart/mixed; boundary=6f1l2aqhirm',
  '',
  '--6f1l2aqhirm',
  'Content-Type: multipart/alternative; boundary=ts60coirirs',
  '',
  '--ts60coirirs',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  'Hi there',
  'line2',
  '',
  '--ts60coirirs',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  '<p>Hi</p>',
  '',
  '--ts60coirirs--',
  '--6f1l2aqhirm',
  'Content-Type: application/pdf; name="a.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="a.pdf"',
  '',
  'AQID',
  '--6f1l2aqhirm--',
]);

/** The same message as lettre (Rust, `build_rfc5322`) builds it. */
const LETTRE = crlf([
  'From: =?utf-8?b?VG9tIMOE?= <tom@acme.com>',
  'Subject: =?utf-8?b?SMOpbGxv?= there',
  'Message-ID: <d2074c239bf747c19ca3da7b873d37dc@acme.com>',
  'To: a@x.com, b@y.com',
  'Cc: c@z.com',
  'Reply-To: r@acme.com',
  'MIME-Version: 1.0',
  'Date: Thu, 29 Oct 2026 14:48:10 +0000',
  'In-Reply-To: <p@x>',
  'References: <a@x> <p@x>',
  'Content-Type: multipart/mixed;',
  ' boundary="3z2TgcVdPlkUYJDPBPGxCc6hHFeu27TqMZzrevGS"',
  '',
  '--3z2TgcVdPlkUYJDPBPGxCc6hHFeu27TqMZzrevGS',
  'Content-Type: multipart/alternative;',
  ' boundary="fXjTxdGgRyxYcKd75Y9VN1V0cadvRyLDJmSo8oHf"',
  '',
  '--fXjTxdGgRyxYcKd75Y9VN1V0cadvRyLDJmSo8oHf',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  'Hi there',
  'line2',
  '--fXjTxdGgRyxYcKd75Y9VN1V0cadvRyLDJmSo8oHf',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  '<p>Hi</p>',
  '--fXjTxdGgRyxYcKd75Y9VN1V0cadvRyLDJmSo8oHf--',
  '--3z2TgcVdPlkUYJDPBPGxCc6hHFeu27TqMZzrevGS',
  'Content-Disposition: attachment; filename="a.pdf"',
  'Content-Type: application/pdf',
  'Content-Transfer-Encoding: base64',
  '',
  'AQID',
  '--3z2TgcVdPlkUYJDPBPGxCc6hHFeu27TqMZzrevGS--',
  '',
]);

afterEach(() => {
  takeRustSends();
  takeRustLedgerCalls();
});

describe('sendRecord', () => {
  it("reads both builders' messages alike", () => {
    const ts = sendRecord('"Tom Ä" <tom@acme.com>', 'a@x.com', MIMETEXT);
    const rust = sendRecord('"Tom Ä" <tom@acme.com>', 'a@x.com', LETTRE);
    expect(rust).toEqual(ts);
    expect(ts).toEqual({
      envelope: { from: '"Tom Ä" <tom@acme.com>', to: 'a@x.com' },
      from: { email: 'tom@acme.com', name: 'Tom Ä' },
      to: ['a@x.com', 'b@y.com'],
      cc: ['c@z.com'],
      replyTo: 'r@acme.com',
      subject: 'Héllo there',
      messageId: '<hex32@acme.com>',
      inReplyTo: '<p@x>',
      references: '<a@x> <p@x>',
      headers: {},
      parts: [
        { type: 'text/plain', filename: null, text: 'Hi there\nline2', size: 0 },
        { type: 'text/html', filename: null, text: '<p>Hi</p>', size: 0 },
        { type: 'application/pdf', filename: 'a.pdf', text: null, size: 3 },
      ],
    });
  });
});

describe('the SEND_EMAIL bridge', () => {
  it('replays envelopes into the stub and answers its refusals', async () => {
    const stub = createSendEmailStub({ 'bad@x.com': 'E_RECIPIENT_SUPPRESSED' });
    const url = await sendEmailUrl({ SEND_EMAIL: stub });
    const send = (to: string) =>
      fetch(`${url}/send?from=${encodeURIComponent('tom@acme.com')}&to=${encodeURIComponent(to)}`, {
        method: 'POST',
        body: LETTRE,
      });
    expect((await send('a@x.com')).status).toBe(204);
    const refused = await send('bad@x.com');
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'E_RECIPIENT_SUPPRESSED' });
    expect(stub.sent.map((s) => s.to)).toEqual(['a@x.com']);
    expect(takeRustSends().map((r) => r.envelope.to)).toEqual(['a@x.com', 'bad@x.com']);
  });

  it('records the TypeScript run and drops its envelopes from the stub', async () => {
    const stub = createSendEmailStub();
    const { env, finish } = recordTypeScriptSends({ SEND_EMAIL: stub });
    await (env.SEND_EMAIL as typeof stub).send({ from: 'tom@acme.com', to: 'a@x.com', raw: MIMETEXT });
    expect(stub.sent).toHaveLength(1);
    expect(finish().map((r) => r.subject)).toEqual(['Héllo there']);
    expect(stub.sent).toHaveLength(0);
  });
});

describe('the ledger bridge', () => {
  it('calls the stub by name and masks reservation ids', async () => {
    const names: string[] = [];
    const ns = {
      idFromName: (name: string) => (names.push(name), name),
      get: () => ({
        commit: async () => undefined,
        requestReview: async () => true,
      }),
    };
    const urls = await ledgerUrls({ OUTBOUND_LEDGER: ns });
    const rpc = (body: unknown) =>
      fetch(`${urls!.OUTBOUND_LEDGER}/rpc`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
    expect(
      await rpc({ binding: 'OUTBOUND_LEDGER', name: 'ws:ws_1', method: 'requestReview', args: [{ kind: 'workspace' }] }),
    ).toEqual({ result: true });
    expect(await rpc({ binding: 'OUTBOUND_LEDGER', name: 'ws:ws_1', method: 'commit', args: ['rabc1', null] })).toEqual({
      result: null,
    });
    expect(names).toEqual(['ws:ws_1', 'ws:ws_1']);
    const rust = takeRustLedgerCalls();
    expect(rust[1]).toEqual({ binding: 'OUTBOUND_LEDGER', name: 'ws:ws_1', method: 'commit', args: ['<reservation>', null] });

    const { env, finish } = recordTypeScriptLedgerCalls({ OUTBOUND_LEDGER: ns });
    const wrapped = env.OUTBOUND_LEDGER as {
      idFromName: (name: string) => unknown;
      get: (id: unknown) => { commit: (id: string, sent?: string[]) => Promise<void> };
    };
    await wrapped.get(wrapped.idFromName('ws:ws_1')).commit('rxyz2', undefined);
    expect(finish()).toEqual([rust[1]]);
  });
});
