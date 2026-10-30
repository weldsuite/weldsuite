import { describe, expect, it } from 'vitest';
import { createMailCollector, mailRecord, type OutgoingEmailLike, type RustMail } from './conformance-mail';

const MEMORY_TRANSPORTS = Symbol.for('weldsuite.emails.memoryTransports');

/** A transport registered the way `memoryTransport()` registers itself. */
function transport() {
  const sent: OutgoingEmailLike[] = [];
  const global = globalThis as { [MEMORY_TRANSPORTS]?: Set<{ sent: OutgoingEmailLike[] }> };
  global[MEMORY_TRANSPORTS] ??= new Set();
  const t = { sent };
  global[MEMORY_TRANSPORTS].add(t);
  return t;
}

function email(subject: string, text: string): OutgoingEmailLike {
  return {
    from: { email: 'notifications@mail.weldsuite.org', name: 'Acme' },
    to: [{ email: 'ann@example.com' }],
    replyTo: { email: 'gert@example.com' },
    subject,
    html: '<p>x</p>',
    text,
    attachments: [{ filename: 'NDA.pdf', contentType: 'application/pdf', content: new Uint8Array([1, 2, 3]) }],
  };
}

const rust = (subject: string, text: string): RustMail => ({
  from: { email: 'notifications@mail.weldsuite.org', name: 'Acme' },
  to: [{ email: 'ann@example.com' }],
  cc: [],
  bcc: [],
  replyTo: { email: 'gert@example.com' },
  subject,
  html: '<p>x</p>',
  text,
  attachments: [{ filename: 'NDA.pdf', contentType: 'application/pdf', contentBase64: 'AQID' }],
  headers: {},
});

describe('conformance mail', () => {
  it('compares envelopes, subjects, attachments and the text with tokens masked', () => {
    const a = mailRecord(email('Your code: 123456', 'Open  https://sign.test/r/AbCdEfGhIjKlMnOpQrStUv\n\nnow'));
    const b = mailRecord(email('Your code: 654321', 'Open https://sign.test/r/ZyXwVuTsRqPoNmLkJiHgFe now'));
    expect(a).toEqual(b);
    expect(a.attachments).toEqual([{ filename: 'NDA.pdf', contentType: 'application/pdf', size: 3 }]);
    expect(mailRecord(email('Hi', 'a'))).not.toEqual(mailRecord(email('Hi', 'b')));
  });

  it('collects what the test transports got and swaps in Rust mail', () => {
    const collector = createMailCollector();
    const t = transport();
    collector.take();
    t.sent.push(email('From TypeScript', 'ts'));
    const typescript = collector.take();
    expect(typescript.map((m) => m.email.subject)).toEqual(['From TypeScript']);

    collector.adopt(typescript, [rust('From Rust', 'rust')]);
    expect(t.sent.map((m) => m.subject)).toEqual(['From Rust']);
    expect(t.sent[0]!.attachments![0]!.content).toEqual(new Uint8Array([1, 2, 3]));
    // Swapped-in mail is not reported again.
    expect(collector.take()).toEqual([]);
  });
});
