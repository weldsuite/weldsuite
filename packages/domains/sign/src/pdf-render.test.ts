import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { appendCertificate, flattenDocument, placeBox, winAnsi } from './pdf-render';

const crop = { x: 0, y: 0, width: 600, height: 800 };
const box = { x: 100, y: 50, width: 160, height: 40 };

/** A 1x1 transparent PNG, enough for pdf-lib to embed. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

describe('placeBox', () => {
  it('maps a box on an unrotated page to its bottom-left corner', () => {
    // Display (100, 50) top-left → page y = 800 - 50 - 40.
    expect(placeBox(box, crop, 0)).toEqual({ x: 100, y: 710, rotate: 0 });
  });

  it('accounts for the crop box origin', () => {
    expect(placeBox(box, { ...crop, x: 20, y: 30 }, 0)).toEqual({ x: 120, y: 740, rotate: 0 });
  });

  it('maps the box on pages rotated by 90, 180 and 270 degrees', () => {
    // On screen the 600x800 page is 800 wide and 600 high when rotated 90/270.
    expect(placeBox(box, crop, 90)).toEqual({ x: 90, y: 100, rotate: 90 });
    expect(placeBox(box, crop, 180)).toEqual({ x: 500, y: 90, rotate: 180 });
    expect(placeBox(box, crop, 270)).toEqual({ x: 510, y: 700, rotate: 270 });
  });

  it('normalises negative rotations', () => {
    expect(placeBox(box, crop, -90).rotate).toBe(270);
  });
});

describe('flattenDocument', () => {
  async function pdf(rotation = 0): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    if (rotation) page.setRotation(degrees(rotation));
    doc.addPage([600, 800]);
    return doc.save();
  }

  it('draws every kind of field and keeps the pages', async () => {
    for (const rotation of [0, 90]) {
      const out = await flattenDocument(await pdf(rotation), [
        { page: 0, ...box, type: 'signature', value: null, image: PNG },
        { page: 0, x: 100, y: 120, width: 110, height: 22, type: 'date_signed', value: '24 Oct 2026', image: null },
        { page: 1, x: 50, y: 50, width: 16, height: 16, type: 'checkbox', value: 'true', image: null },
        { page: 1, x: 50, y: 90, width: 200, height: 22, type: 'text', value: 'Łódź – naïve ☃', image: null },
        { page: 5, x: 0, y: 0, width: 10, height: 10, type: 'text', value: 'no such page', image: null },
      ]);
      const doc = await PDFDocument.load(out);
      expect(doc.getPageCount()).toBe(2);
    }
  });
});

describe('winAnsi', () => {
  it('replaces characters Helvetica cannot show', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(winAnsi(font, 'Café\nnaïve')).toBe('Café naïve');
    expect(winAnsi(font, 'Łódź ☃')).toBe('?ód? ?');
  });
});

describe('appendCertificate', () => {
  it('adds a page with the request, its documents and the recipients', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await appendCertificate(doc, {
      envelopeId: 'sgn_1',
      title: 'Service agreement',
      senderName: 'Gert',
      senderEmail: 'gert@example.com',
      workspaceName: 'Acme',
      sentAt: new Date('2026-10-24T10:00:00Z'),
      completedAt: new Date('2026-10-25T10:00:00Z'),
      documents: [{ name: 'contract.pdf', pageCount: 2, sha256: 'a'.repeat(64) }],
      recipients: Array.from({ length: 8 }, (_, i) => ({
        name: `Signer ${i}`,
        email: `s${i}@example.com`,
        role: 'signer' as const,
        authMode: 'email_code',
        signatureKind: 'drawn',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        sentAt: new Date(),
        openedAt: new Date(),
        consentedAt: new Date(),
        signedAt: new Date(),
      })),
      disclosureVersion: '2026-10-24',
    });
    // Eight signers do not fit on one page.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    const reloaded = await PDFDocument.load(await doc.save());
    expect(reloaded.getPageCount()).toBe(doc.getPageCount());
  });
});
