// Writes the PDF fixtures in rust/modules/sign/tests/fixtures/pdf/ from the
// TypeScript renderer (packages/domains/sign/src/pdf-render.ts, pdf-lib):
//
//   original.pdf      pages of every orientation the editor handles
//   fields.json       the fields drawn into it (PNG images in base64)
//   flattened.pdf     flattenDocument(original, fields)
//   certificate.json  a certificate input
//   certificate.pdf   appendCertificate on a new document
//
// The Rust tests (src/pdf_render/tests.rs) draw the same input and compare
// what both files draw: text, fonts, sizes, positions, images and lines.
//
//   pnpm exec tsx rust/modules/sign/tools/pdf-fixtures.mts
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const out = path.join(repo, 'rust/modules/sign/tests/fixtures/pdf');
const requireFromSign = createRequire(path.join(repo, 'packages/domains/sign/package.json'));
const { PDFDocument, StandardFonts, degrees } = requireFromSign('pdf-lib') as typeof import('pdf-lib');
const render = (await import(pathToFileURL(path.join(repo, 'packages/domains/sign/src/pdf-render.ts')).href)) as typeof import('../../../../packages/domains/sign/src/pdf-render');

/** A PNG from raw rows (no filter), colour type 0, 2, 4 or 6, 8 bits. */
function png(width: number, height: number, colorType: number, pixels: number[]): Uint8Array {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]!;
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    raw.push(...pixels.slice(y * width * channels, (y + 1) * width * channels));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...Buffer.from(type, 'ascii'), ...data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.from(raw))),
      chunk('IEND', new Uint8Array()),
    ]),
  );
}

const rgba = png(4, 2, 6, [
  20, 30, 40, 255, 20, 30, 40, 128, 0, 0, 0, 0, 200, 10, 10, 255,
  20, 30, 40, 0, 50, 60, 70, 255, 1, 2, 3, 64, 9, 9, 9, 255,
]);
const gray = png(3, 2, 0, [0, 128, 255, 255, 128, 0]);
const opaqueRgb = png(2, 3, 2, [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

// --- original.pdf ---------------------------------------------------------
const doc = await PDFDocument.create();
const helvetica = await doc.embedFont(StandardFonts.Helvetica);
const label = (page: ReturnType<typeof doc.addPage>, text: string) => page.drawText(text, { x: 40, y: 40, size: 10, font: helvetica });
label(doc.addPage([595, 842]), 'Portrait');
label(doc.addPage([842, 595]), 'Landscape');
const turned = doc.addPage([595, 842]);
turned.setRotation(degrees(90));
label(turned, 'Rotated 90');
const cropped = doc.addPage([600, 800]);
cropped.setCropBox(20, 30, 560, 750);
cropped.setRotation(degrees(270));
label(cropped, 'Cropped, rotated 270');
const upside = doc.addPage([595, 842]);
upside.setRotation(degrees(180));
label(upside, 'Rotated 180');
const original = await doc.save({ useObjectStreams: false });

// --- fields.json ----------------------------------------------------------
type Field = { page: number; x: number; y: number; width: number; height: number; type: string; value: string | null; image: string | null };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fields: Field[] = [
  { page: 0, x: 50, y: 100, width: 160, height: 40, type: 'signature', value: null, image: b64(rgba) },
  { page: 0, x: 50, y: 150, width: 160, height: 22, type: 'date_signed', value: '2026-11-02', image: null },
  { page: 0, x: 50, y: 180, width: 60, height: 14, type: 'text', value: 'Director of Operations and Strategic Partnerships Europe', image: null },
  { page: 0, x: 50, y: 200, width: 220, height: 22, type: 'name', value: 'Zoë Ångström 名前 — “quotes” €\tand\nmore', image: null },
  { page: 0, x: 300, y: 100, width: 120, height: 30, type: 'email', value: 'ann.de.vries@example.com', image: null },
  { page: 0, x: 300, y: 140, width: 100, height: 20, type: 'text', value: '', image: null },
  { page: 1, x: 100, y: 100, width: 16, height: 16, type: 'checkbox', value: 'true', image: null },
  { page: 1, x: 130, y: 100, width: 16, height: 16, type: 'checkbox', value: 'false', image: null },
  { page: 1, x: 200, y: 300, width: 60, height: 30, type: 'initials', value: null, image: b64(gray) },
  { page: 2, x: 60, y: 80, width: 180, height: 24, type: 'text', value: 'Turned with the page', image: null },
  { page: 2, x: 60, y: 120, width: 120, height: 50, type: 'signature', value: null, image: b64(opaqueRgb) },
  { page: 3, x: 30, y: 40, width: 150, height: 20, type: 'text', value: 'Cropped and turned', image: null },
  { page: 3, x: 30, y: 70, width: 20, height: 20, type: 'checkbox', value: 'true', image: null },
  { page: 4, x: 100, y: 200, width: 200, height: 30, type: 'company', value: 'WeldSuite B.V.', image: null },
  { page: 9, x: 1, y: 1, width: 10, height: 10, type: 'text', value: 'No such page', image: null },
];
const flattened = await render.flattenDocument(
  original,
  fields.map((f) => ({ ...f, type: f.type as never, image: f.image ? new Uint8Array(Buffer.from(f.image, 'base64')) : null })),
);

// --- certificate ----------------------------------------------------------
const recipient = (i: number, extra: Record<string, unknown> = {}) => ({
  name: `Signer ${i}`,
  email: `signer${i}@example.com`,
  role: 'signer',
  authMode: ['link', 'email_code', 'access_code'][i % 3],
  signatureKind: i % 2 ? 'typed' : 'drawn',
  ip: `203.0.113.${i}`,
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.${i}`,
  sentAt: '2026-11-01T08:00:00.000Z',
  openedAt: '2026-11-01T09:15:30.123Z',
  consentedAt: '2026-11-01T09:16:00.000Z',
  signedAt: '2026-11-01T09:20:45.999Z',
  ...extra,
});
const certificate = {
  envelopeId: 'sgn_0fixture00001',
  title: 'Service agreement between WeldSuite B.V. and Ångström Consulting — with an annex that makes this title wrap onto a second line',
  senderName: 'Gert',
  senderEmail: 'gert@example.com',
  workspaceName: 'Acme Staffing',
  sentAt: '2026-11-01T08:00:00.000Z',
  completedAt: '2026-11-02T10:30:00.000Z',
  documents: [
    { name: 'agreement.pdf', pageCount: 2, sha256: 'a'.repeat(64) },
    { name: 'annex.pdf', pageCount: 1, sha256: 'b'.repeat(64) },
  ],
  recipients: [
    recipient(1),
    recipient(2, { name: null }),
    { name: 'Carl', email: 'carl@example.com', role: 'cc', authMode: 'link', signatureKind: null, ip: null, userAgent: null, sentAt: null, openedAt: null, consentedAt: null, signedAt: null },
    recipient(4, { signatureKind: null, ip: null, userAgent: null, openedAt: null, consentedAt: null }),
    recipient(5, { name: 'Zoë 名前' }),
    recipient(6),
  ],
  disclosureVersion: '2026-10-24',
};
const date = (v: unknown) => (typeof v === 'string' ? new Date(v) : null);
const certDoc = await PDFDocument.create();
await render.appendCertificate(certDoc, {
  ...certificate,
  sentAt: date(certificate.sentAt),
  completedAt: new Date(certificate.completedAt),
  recipients: certificate.recipients.map((r) => ({
    ...r,
    role: r.role as 'signer' | 'cc',
    sentAt: date(r.sentAt),
    openedAt: date(r.openedAt),
    consentedAt: date(r.consentedAt),
    signedAt: date(r.signedAt),
  })) as never,
});
const certBytes = await certDoc.save({ useObjectStreams: false });

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'original.pdf'), original);
writeFileSync(path.join(out, 'fields.json'), `${JSON.stringify(fields, null, 2)}\n`);
writeFileSync(path.join(out, 'flattened.pdf'), flattened);
writeFileSync(path.join(out, 'certificate.json'), `${JSON.stringify(certificate, null, 2)}\n`);
writeFileSync(path.join(out, 'certificate.pdf'), certBytes);
console.log(`wrote ${out}`);
