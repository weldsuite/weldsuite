/**
 * Drawing signed values into PDFs, and the certificate of completion.
 *
 * Field boxes are stored in PDF points of the page *as displayed* (origin top
 * left, crop box, /Rotate applied), the frame the editor and pdf.js use. To
 * draw into the page itself they are mapped back to page space, and the
 * content is rotated with the page so it reads upright on screen.
 *
 * Standard fonts only (Helvetica): text is reduced to WinAnsi, so a character
 * the font cannot show becomes "?" instead of failing the whole document.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { SignFieldType } from '@weldsuite/db/schema';

export interface RenderField {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: SignFieldType;
  /** Text to draw: name, email, date, text, and 'true'/'false' for a checkbox. */
  value: string | null;
  /** PNG bytes of the adopted signature or initials. */
  image: Uint8Array | null;
}

/** Where an element whose display box is `box` lands in page space, and how it is turned. */
export interface Placement {
  /** Page-space point that is the element's bottom-left corner before rotation. */
  x: number;
  y: number;
  /** Counter-clockwise rotation in degrees (the page's /Rotate). */
  rotate: number;
}

/**
 * Map a box in display space (origin top-left of the rotated, cropped page)
 * to page space. `crop` is the page's crop box in page space; `rotation` its
 * /Rotate (0, 90, 180 or 270, clockwise on screen).
 */
export function placeBox(
  box: { x: number; y: number; width: number; height: number },
  crop: { x: number; y: number; width: number; height: number },
  rotation: number,
): Placement {
  const W = crop.width;
  const H = crop.height;
  // The element's bottom-left corner on screen.
  const u = box.x;
  const v = box.y + box.height;
  let px: number;
  let py: number;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      px = v;
      py = u;
      break;
    case 180:
      px = W - u;
      py = v;
      break;
    case 270:
      px = W - v;
      py = H - u;
      break;
    default:
      px = u;
      py = H - v;
  }
  return { x: crop.x + px, y: crop.y + py, rotate: ((rotation % 360) + 360) % 360 };
}

/** Offset within the element (local x right, y up) turned into page space. */
function offset(p: Placement, dx: number, dy: number): { x: number; y: number } {
  switch (p.rotate) {
    case 90:
      return { x: p.x - dy, y: p.y + dx };
    case 180:
      return { x: p.x - dx, y: p.y - dy };
    case 270:
      return { x: p.x + dy, y: p.y - dx };
    default:
      return { x: p.x + dx, y: p.y + dy };
  }
}

/** Replace what Helvetica (WinAnsi) cannot encode. */
export function winAnsi(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

const INK = rgb(0.07, 0.09, 0.15);

function drawTextField(page: PDFPage, font: PDFFont, field: RenderField, p: Placement): void {
  const text = winAnsi(font, field.value ?? '');
  if (!text) return;
  let size = Math.min(field.height * 0.7, 14);
  const maxWidth = field.width - 4;
  while (size > 5 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  // Vertically centred, 2pt in from the left.
  const dy = (field.height - font.heightAtSize(size)) / 2 + font.heightAtSize(size) * 0.2;
  const at = offset(p, 2, Math.max(dy, 0));
  page.drawText(text, { x: at.x, y: at.y, size, font, color: INK, rotate: degrees(p.rotate), maxWidth });
}

function drawCheckbox(page: PDFPage, field: RenderField, p: Placement): void {
  if (field.value !== 'true') return;
  // A check mark from two strokes, scaled to the box.
  const w = field.width;
  const h = field.height;
  const a = offset(p, w * 0.2, h * 0.5);
  const b = offset(p, w * 0.42, h * 0.22);
  const c = offset(p, w * 0.82, h * 0.82);
  const thickness = Math.max(Math.min(w, h) * 0.12, 1);
  page.drawLine({ start: a, end: b, thickness, color: INK });
  page.drawLine({ start: b, end: c, thickness, color: INK });
}

async function drawImageField(doc: PDFDocument, page: PDFPage, field: RenderField, p: Placement): Promise<void> {
  if (!field.image) return;
  const png = await doc.embedPng(field.image);
  // Fit inside the box, keeping the image's proportions, centred.
  const scale = Math.min(field.width / png.width, field.height / png.height);
  const w = png.width * scale;
  const h = png.height * scale;
  const at = offset(p, (field.width - w) / 2, (field.height - h) / 2);
  page.drawImage(png, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(p.rotate) });
}

/** Draw `fields` into `doc` (in place). */
export async function drawFields(doc: PDFDocument, fields: RenderField[]): Promise<void> {
  if (fields.length === 0) return;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const field of fields) {
    const page = pages[field.page];
    if (!page) continue;
    const p = placeBox(field, page.getCropBox(), page.getRotation().angle);
    if (field.type === 'signature' || field.type === 'initials') await drawImageField(doc, page, field, p);
    else if (field.type === 'checkbox') drawCheckbox(page, field, p);
    else drawTextField(page, font, field, p);
  }
}

/** A document with `fields` drawn in, as new PDF bytes. */
export async function flattenDocument(original: Uint8Array, fields: RenderField[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });
  await drawFields(doc, fields);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Certificate of completion
// ---------------------------------------------------------------------------

export interface CertificateRecipient {
  name: string | null;
  email: string | null;
  role: 'signer' | 'cc';
  authMode: string;
  signatureKind: string | null;
  ip: string | null;
  userAgent: string | null;
  sentAt: Date | null;
  openedAt: Date | null;
  consentedAt: Date | null;
  signedAt: Date | null;
}

export interface CertificateInput {
  envelopeId: string;
  title: string;
  senderName: string | null;
  senderEmail: string | null;
  workspaceName: string;
  sentAt: Date | null;
  completedAt: Date;
  documents: { name: string; pageCount: number; sha256: string }[];
  recipients: CertificateRecipient[];
  disclosureVersion: string;
}

const AUTH_LABELS: Record<string, string> = {
  link: 'Email link',
  email_code: 'Email link and one-time code',
  access_code: 'Email link and access code',
};

const utc = (d: Date | null) => (d ? `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-');

/** Append the certificate page(s) to `doc`. */
export async function appendCertificate(doc: PDFDocument, input: CertificateInput): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const W = 595.28;
  const H = 841.89;
  const margin = 50;
  let page = doc.addPage([W, H]);
  let y = H - margin;

  const ensure = (needed: number) => {
    if (y - needed < margin) {
      page = doc.addPage([W, H]);
      y = H - margin;
    }
  };
  const line = (text: string, opts: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const size = opts.size ?? 9;
    const f = opts.f ?? font;
    ensure(size + 4);
    page.drawText(winAnsi(f, text), { x: margin, y: y - size, size, font: f, color: opts.color ?? INK, maxWidth: W - 2 * margin });
    y -= size + (opts.gap ?? 4);
  };
  const row = (label: string, value: string) => {
    ensure(13);
    page.drawText(winAnsi(font, label), { x: margin, y: y - 9, size: 9, font, color: rgb(0.42, 0.45, 0.5) });
    page.drawText(winAnsi(font, value), { x: margin + 130, y: y - 9, size: 9, font, color: INK, maxWidth: W - 2 * margin - 130 });
    y -= 13;
  };
  const rule = () => {
    ensure(12);
    page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: W - margin, y: y - 4 }, thickness: 0.5, color: rgb(0.85, 0.86, 0.88) });
    y -= 12;
  };

  line('Certificate of completion', { size: 18, f: bold, gap: 6 });
  line(`Electronic signatures by WeldSign for ${input.workspaceName}`, { size: 9, color: rgb(0.42, 0.45, 0.5), gap: 14 });

  row('Request', input.title);
  row('Request id', input.envelopeId);
  row('Sent by', [input.senderName, input.senderEmail ? `<${input.senderEmail}>` : null].filter(Boolean).join(' ') || '-');
  row('Sent', utc(input.sentAt));
  row('Completed', utc(input.completedAt));
  row('Disclosure version', input.disclosureVersion);
  rule();

  line('Documents', { size: 11, f: bold, gap: 6 });
  for (const d of input.documents) {
    line(`${d.name} (${d.pageCount} page${d.pageCount === 1 ? '' : 's'})`, { gap: 2 });
    line(`SHA-256 of the original: ${d.sha256}`, { size: 7.5, f: mono, color: rgb(0.3, 0.32, 0.36), gap: 8 });
  }
  rule();

  line('Recipients', { size: 11, f: bold, gap: 6 });
  for (const r of input.recipients) {
    ensure(110);
    line(`${r.name ?? r.email ?? '-'}${r.email && r.name ? ` <${r.email}>` : ''}`, { size: 10, f: bold, gap: 4 });
    row('Role', r.role === 'signer' ? 'Signer' : 'Receives a copy');
    if (r.role === 'signer') {
      row('Identity check', AUTH_LABELS[r.authMode] ?? r.authMode);
      row('Signature', r.signatureKind ? `${r.signatureKind[0]!.toUpperCase()}${r.signatureKind.slice(1)}` : '-');
      row('Sent', utc(r.sentAt));
      row('Opened', utc(r.openedAt));
      row('Agreed to sign electronically', utc(r.consentedAt));
      row('Signed', utc(r.signedAt));
      row('IP address', r.ip ?? '-');
      row('Browser', (r.userAgent ?? '-').slice(0, 110));
    }
    y -= 6;
  }
  rule();
  line(
    'The SHA-256 fingerprint of this complete file is recorded by WeldSign when it is created; compare it to check that the file has not been changed since.',
    { size: 7.5, color: rgb(0.42, 0.45, 0.5) },
  );
}
