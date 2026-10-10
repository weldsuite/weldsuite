/**
 * PDF rendering of payroll documents with pdf-lib. Runs in Cloudflare Workers
 * (and Node): only the standard Helvetica fonts, so every string is cut down
 * to what WinAnsi can encode first.
 *
 * - `renderPayslipPdf(view, lang)`: a Dutch loonstrook / US pay stub.
 * - `renderDocumentPdf(doc)`: any `PayrollDocument` (jaaropgaaf, W-2, 941
 *   worksheet, loonaangifte summary): a title, issuer/recipient blocks and
 *   field, table and text sections.
 *
 * Layout never decides content: lines come from the engines, labels from
 * `payslipLineLabel`; the fixed texts below exist in English and Dutch.
 */

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PayrollDocument } from './documents';
import { payslipLineLabel } from './labels';
import type { Cents } from './money';
import type { PayslipLine } from './types';

type Lang = 'en' | 'nl';

// ---------------------------------------------------------------------------
// The payslip, as the renderer takes it
// ---------------------------------------------------------------------------

export interface PayslipTotalsView {
  grossCents: Cents;
  taxableWageCents: Cents;
  employeeTaxesCents: Cents;
  employeeDeductionsCents: Cents;
  reimbursementsCents: Cents;
  netCents: Cents;
  employerTaxesCents: Cents;
  employerCostCents: Cents;
}

/** Year-to-date after this payslip, from the stored payslips (engine independent). */
export interface PayslipYtdView {
  totals: PayslipTotalsView;
  /** Amount per line, keyed by `payslipLineKey`. */
  byLine: Record<string, Cents>;
}

export interface PayslipView {
  country: 'NL' | 'US';
  currency: string;
  /** Null for a draft. */
  number: string | null;
  employer: {
    name: string;
    legalName?: string | null;
    address: string[];
    /** Loonheffingennummer / EIN. */
    taxId?: { label: string; value: string } | null;
  };
  employee: {
    name: string;
    address: string[];
    employeeNumber?: string | null;
    jobTitle?: string | null;
    /** Already masked (`•••••1234` / `***-**-1234`): a payslip never prints a full national id. */
    taxIdMasked?: string | null;
    dateOfBirth?: string | null;
  };
  period: { start: string; end: string; payDate: string; periodNumber: number; taxYear: number };
  lines: PayslipLine[];
  totals: PayslipTotalsView;
  ytd?: PayslipYtdView | null;
  /** Items art. 7:626 BW requires on a Dutch payslip. */
  nl?: {
    contractHoursPerWeek: number | null;
    writtenContract: boolean;
    indefiniteContract: boolean;
    onCall: boolean;
    /** The statutory minimum hourly wage applicable to the employee, when known. */
    minimumHourlyWageCents?: Cents | null;
  } | null;
  us?: { workState: string | null } | null;
  /** Masked account the net pay goes to (`NL91 •••• •••• 4300`). */
  payTo?: string | null;
  /** The payslip shows only the difference with an earlier payslip. */
  correction?: { originalNumber: string | null } | null;
  /** Diagonal text, `"CONCEPT"` / `"DRAFT"`. */
  watermark?: string | null;
}

/** Key that identifies a payslip line across payslips (for the YTD column). */
export function payslipLineKey(line: Pick<PayslipLine, 'section' | 'code' | 'jurisdiction' | 'label'>): string {
  return `${line.section}|${line.code}|${line.jurisdiction ?? ''}|${line.label ?? ''}`;
}

// ---------------------------------------------------------------------------
// Fixed texts
// ---------------------------------------------------------------------------

const TEXT = {
  en: {
    payslip: 'Payslip',
    payStub: 'Pay stub',
    employer: 'Employer',
    employee: 'Employee',
    period: 'Period',
    payDate: 'Pay date',
    number: 'Payslip no.',
    periodNo: 'Period no.',
    taxYear: 'Tax year',
    employeeNo: 'Employee no.',
    jobTitle: 'Job title',
    dateOfBirth: 'Date of birth',
    description: 'Description',
    quantity: 'Qty',
    rate: 'Rate',
    amount: 'Amount',
    ytd: 'Year to date',
    earning: 'Earnings',
    deduction: 'Deductions',
    tax: 'Taxes withheld',
    reimbursement: 'Reimbursements',
    employerCosts: 'Employer costs (not deducted from your pay)',
    info: 'Information',
    summary: 'Summary',
    gross: 'Gross pay',
    taxableNl: 'Wage for payroll tax',
    taxableUs: 'Federal taxable wages',
    taxes: 'Taxes withheld',
    deductions: 'Deductions',
    reimbursements: 'Reimbursements',
    net: 'Net pay',
    employerTaxes: 'Employer taxes',
    employerCost: 'Total employer cost',
    contract: 'Contract',
    contractWritten: 'written',
    contractNotWritten: 'not in writing',
    contractOpen: 'open-ended',
    contractFixed: 'fixed term',
    contractOnCall: 'on-call contract',
    contractNotOnCall: 'not an on-call contract',
    hoursPerWeek: 'Agreed hours per week',
    minimumWage: 'Applicable statutory minimum hourly wage',
    minimumWageSee: 'see wetten.overheid.nl (Wet minimumloon)',
    state: 'Work state',
    payTo: 'Paid to',
    correctionOf: 'Correction of payslip',
    correctionNote: 'This document shows only the difference with the earlier payslip.',
    page: 'Page',
    of: 'of',
    taxId: 'Tax ID',
  },
  nl: {
    payslip: 'Loonstrook',
    payStub: 'Loonstrook',
    employer: 'Werkgever',
    employee: 'Werknemer',
    period: 'Periode',
    payDate: 'Betaaldatum',
    number: 'Loonstrooknr.',
    periodNo: 'Periodenr.',
    taxYear: 'Belastingjaar',
    employeeNo: 'Personeelsnr.',
    jobTitle: 'Functie',
    dateOfBirth: 'Geboortedatum',
    description: 'Omschrijving',
    quantity: 'Aantal',
    rate: 'Tarief',
    amount: 'Bedrag',
    ytd: 'Cumulatief',
    earning: 'Inkomsten',
    deduction: 'Inhoudingen',
    tax: 'Ingehouden belastingen en premies',
    reimbursement: 'Vergoedingen',
    employerCosts: 'Werkgeverslasten (niet ingehouden op uw loon)',
    info: 'Informatie',
    summary: 'Samenvatting',
    gross: 'Bruto loon',
    taxableNl: 'Loon voor de loonbelasting',
    taxableUs: 'Federaal belastbaar loon',
    taxes: 'Ingehouden loonheffing',
    deductions: 'Inhoudingen',
    reimbursements: 'Vergoedingen',
    net: 'Netto uitbetaald',
    employerTaxes: 'Werkgeverspremies',
    employerCost: 'Totale werkgeverskosten',
    contract: 'Arbeidsovereenkomst',
    contractWritten: 'schriftelijk',
    contractNotWritten: 'niet schriftelijk',
    contractOpen: 'voor onbepaalde tijd',
    contractFixed: 'voor bepaalde tijd',
    contractOnCall: 'oproepovereenkomst',
    contractNotOnCall: 'geen oproepovereenkomst',
    hoursPerWeek: 'Overeengekomen uren per week',
    minimumWage: 'Toepasselijk wettelijk minimumuurloon',
    minimumWageSee: 'zie wetten.overheid.nl (Wet minimumloon)',
    state: 'Werkstaat',
    payTo: 'Betaald op',
    correctionOf: 'Correctie op loonstrook',
    correctionNote: 'Dit document toont alleen het verschil met de eerdere loonstrook.',
    page: 'Pagina',
    of: 'van',
    taxId: 'Belastingnr.',
  },
} as const;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

/** `123456` → `€ 1.234,56` (nl) or `€1,234.56` (en). Negative amounts keep a leading minus. */
export function formatMoney(cents: Cents, currency: string, lang: Lang): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = String(Math.floor(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');
  const groupSep = lang === 'nl' ? '.' : ',';
  const decimalSep = lang === 'nl' ? ',' : '.';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const symbol = CURRENCY_SYMBOL[currency] ?? currency;
  const space = lang === 'nl' || !CURRENCY_SYMBOL[currency] ? ' ' : '';
  return `${negative ? '-' : ''}${symbol}${space}${grouped}${decimalSep}${fraction}`;
}

function formatNumber(value: number, lang: Lang): string {
  const fixed = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  return lang === 'nl' ? fixed.replace('.', ',') : fixed;
}

/** `2026-07-31` → `31-07-2026` (nl) or `07/31/2026` (en). */
export function formatDate(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return lang === 'nl' ? `${m[3]}-${m[2]}-${m[1]}` : `${m[2]}/${m[3]}/${m[1]}`;
}

// ---------------------------------------------------------------------------
// Drawing toolkit
// ---------------------------------------------------------------------------

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 56;

const INK = rgb(0.12, 0.13, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.84, 0.87);
const SHADE = rgb(0.95, 0.96, 0.97);

class Canvas {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  private readonly supported: Set<number>;

  constructor(
    readonly pdf: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    private readonly watermark: string | null,
    private readonly onNewPage?: (canvas: Canvas) => void,
  ) {
    this.supported = new Set(font.getCharacterSet());
    this.addPage(true);
  }

  /** Cut a string down to what the standard fonts can encode. */
  clean(text: string): string {
    let out = '';
    for (const ch of text.normalize('NFC')) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
        out += ' ';
      } else if (cp === 0x2212) {
        out += '-';
      } else if (this.supported.has(cp)) {
        out += ch;
      } else {
        const base = ch.normalize('NFD')[0]!;
        out += this.supported.has(base.codePointAt(0)!) ? base : '?';
      }
    }
    return out;
  }

  addPage(first = false) {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
    if (this.watermark) this.drawWatermark(this.page);
    if (!first) this.onNewPage?.(this);
  }

  private drawWatermark(page: PDFPage) {
    const text = this.clean(this.watermark ?? '');
    const size = 96;
    const width = this.bold.widthOfTextAtSize(text, size);
    // Centre the text on the page, rotated 45 degrees about its own middle.
    const angle = 45;
    const rad = (angle * Math.PI) / 180;
    const cx = PAGE_W / 2;
    const cy = PAGE_H / 2;
    page.drawText(text, {
      x: cx - (width / 2) * Math.cos(rad) + (size / 3) * Math.sin(rad),
      y: cy - (width / 2) * Math.sin(rad) - (size / 3) * Math.cos(rad),
      size,
      font: this.bold,
      color: rgb(0.9, 0.9, 0.92),
      rotate: degrees(angle),
    });
  }

  ensure(height: number) {
    if (this.y - height < BOTTOM) this.addPage();
  }

  width(text: string, size: number, bold = false): number {
    return (bold ? this.bold : this.font).widthOfTextAtSize(this.clean(text), size);
  }

  text(text: string, x: number, size = 9, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; y?: number } = {}) {
    this.page.drawText(this.clean(text), {
      x,
      y: opts.y ?? this.y,
      size,
      font: opts.bold ? this.bold : this.font,
      color: opts.color ?? INK,
    });
  }

  /** Text whose right edge is at `xRight`. */
  textRight(text: string, xRight: number, size = 9, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; y?: number } = {}) {
    const w = this.width(text, size, opts.bold);
    this.text(text, xRight - w, size, opts);
  }

  /** Cut with an ellipsis so it fits `maxWidth`. */
  fit(text: string, maxWidth: number, size: number, bold = false): string {
    const cleaned = this.clean(text);
    if (this.width(cleaned, size, bold) <= maxWidth) return cleaned;
    let cut = cleaned;
    while (cut.length > 1 && this.width(`${cut}…`, size, bold) > maxWidth) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
  }

  /** Word-wrap into lines no wider than `maxWidth`. */
  wrap(text: string, maxWidth: number, size: number, bold = false): string[] {
    const out: string[] = [];
    for (const paragraph of this.clean(text).split(/\n/)) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.width(candidate, size, bold) <= maxWidth) {
          line = candidate;
        } else {
          if (line) out.push(line);
          line = this.width(word, size, bold) <= maxWidth ? word : this.fit(word, maxWidth, size, bold);
        }
      }
      out.push(line);
    }
    return out;
  }

  rule(x1 = MARGIN, x2 = PAGE_W - MARGIN, color = RULE, thickness = 0.6) {
    this.page.drawLine({ start: { x: x1, y: this.y }, end: { x: x2, y: this.y }, thickness, color });
  }

  shade(height: number, x = MARGIN, width = CONTENT_W) {
    this.page.drawRectangle({ x, y: this.y - 3, width, height, color: SHADE });
  }

  /** Page numbers and a footer line on every page, once all pages exist. */
  finish(footerLines: string[], pageWord: string, ofWord: string) {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      let y = 34;
      for (const line of footerLines) {
        page.drawText(this.clean(line), { x: MARGIN, y, size: 7, font: this.font, color: MUTED });
        y -= 9;
      }
      const label = this.clean(`${pageWord} ${index + 1} ${ofWord} ${total}`);
      const w = this.font.widthOfTextAtSize(label, 7);
      page.drawText(label, { x: PAGE_W - MARGIN - w, y: 34, size: 7, font: this.font, color: MUTED });
    });
  }
}

async function newCanvas(
  watermark: string | null | undefined,
  onNewPage?: (canvas: Canvas) => void,
): Promise<Canvas> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return new Canvas(pdf, font, bold, watermark?.trim() ? watermark.trim() : null, onNewPage);
}

// ---------------------------------------------------------------------------
// Payslip
// ---------------------------------------------------------------------------

type Section = PayslipLine['section'];

const SECTION_ORDER: Section[] = ['earning', 'deduction', 'tax', 'reimbursement'];

function lineQuantity(line: PayslipLine, lang: Lang): string {
  return line.quantity === null || line.quantity === undefined ? '' : formatNumber(line.quantity, lang);
}

/** A rate is a plain number: an hourly rate or a percentage, as the engine put it on the line. */
function lineRate(line: PayslipLine, lang: Lang): string {
  if (line.rate === null || line.rate === undefined) return '';
  return formatNumber(line.rate, lang);
}

export async function renderPayslipPdf(view: PayslipView, lang: Lang): Promise<Uint8Array> {
  const t = TEXT[lang];
  const title = view.country === 'US' ? t.payStub : t.payslip;
  const canvas = await newCanvas(view.watermark, (c) => {
    c.text(`${title} ${view.number ?? ''}`.trim(), MARGIN, 9, { bold: true });
    c.textRight(`${view.employee.name}`, PAGE_W - MARGIN, 9, { color: MUTED });
    c.y -= 8;
    c.rule();
    c.y -= 16;
  });
  const money = (cents: Cents) => formatMoney(cents, view.currency, lang);

  // --- Header
  canvas.text(title, MARGIN, 20, { bold: true });
  canvas.textRight(view.employer.name, PAGE_W - MARGIN, 11, { bold: true });
  canvas.y -= 16;
  canvas.text(`${formatDate(view.period.start, lang)} - ${formatDate(view.period.end, lang)}`, MARGIN, 10, { color: MUTED });
  canvas.y -= 24;

  if (view.correction) {
    canvas.shade(26);
    canvas.text(`${t.correctionOf} ${view.correction.originalNumber ?? ''}`.trim(), MARGIN + 8, 9, { bold: true, y: canvas.y + 11 });
    canvas.text(t.correctionNote, MARGIN + 8, 8, { color: MUTED, y: canvas.y + 1 });
    canvas.y -= 30;
  }

  // --- Employer and employee blocks
  const colW = (CONTENT_W - 20) / 2;
  const rightX = MARGIN + colW + 20;
  const startY = canvas.y;
  canvas.text(t.employer, MARGIN, 8, { color: MUTED, y: startY });
  canvas.text(t.employee, rightX, 8, { color: MUTED, y: startY });
  let leftY = startY - 12;
  let rightY = startY - 12;
  const employerBlock = [
    view.employer.legalName && view.employer.legalName !== view.employer.name ? view.employer.legalName : view.employer.name,
    ...view.employer.address,
    view.employer.taxId ? `${view.employer.taxId.label}: ${view.employer.taxId.value}` : null,
  ].filter((l): l is string => Boolean(l));
  for (const line of employerBlock) {
    canvas.text(canvas.fit(line, colW, 9), MARGIN, 9, { y: leftY });
    leftY -= 11;
  }
  const employeeBlock = [
    view.employee.name,
    ...view.employee.address,
    view.employee.employeeNumber ? `${t.employeeNo}: ${view.employee.employeeNumber}` : null,
    view.employee.jobTitle ? `${t.jobTitle}: ${view.employee.jobTitle}` : null,
    view.employee.dateOfBirth ? `${t.dateOfBirth}: ${formatDate(view.employee.dateOfBirth, lang)}` : null,
    view.employee.taxIdMasked ? `${view.country === 'NL' ? 'BSN' : 'SSN'}: ${view.employee.taxIdMasked}` : null,
  ].filter((l): l is string => Boolean(l));
  for (const line of employeeBlock) {
    canvas.text(canvas.fit(line, colW, 9), rightX, 9, { y: rightY });
    rightY -= 11;
  }
  canvas.y = Math.min(leftY, rightY) - 8;

  // --- Facts: period, pay date, number, and the payslip-required items
  const facts: Array<[string, string]> = [
    [t.period, `${formatDate(view.period.start, lang)} - ${formatDate(view.period.end, lang)}`],
    [t.payDate, formatDate(view.period.payDate, lang)],
    [t.number, view.number ?? '-'],
    [t.periodNo, `${view.period.periodNumber} / ${view.period.taxYear}`],
  ];
  if (view.nl) {
    const nl = view.nl;
    facts.push([
      t.contract,
      [
        nl.writtenContract ? t.contractWritten : t.contractNotWritten,
        nl.indefiniteContract ? t.contractOpen : t.contractFixed,
        nl.onCall ? t.contractOnCall : t.contractNotOnCall,
      ].join(', '),
    ]);
    facts.push([t.hoursPerWeek, nl.contractHoursPerWeek === null ? '-' : formatNumber(nl.contractHoursPerWeek, lang)]);
    facts.push([
      t.minimumWage,
      nl.minimumHourlyWageCents === null || nl.minimumHourlyWageCents === undefined
        ? t.minimumWageSee
        : money(nl.minimumHourlyWageCents),
    ]);
  }
  if (view.us?.workState) facts.push([t.state, view.us.workState]);
  if (view.payTo) facts.push([t.payTo, view.payTo]);

  canvas.rule();
  canvas.y -= 13;
  for (const [label, value] of facts) {
    canvas.ensure(14);
    canvas.text(label, MARGIN, 8.5, { color: MUTED });
    canvas.text(canvas.fit(value, CONTENT_W - 190, 8.5), MARGIN + 190, 8.5);
    canvas.y -= 12;
  }
  canvas.y -= 2;
  canvas.rule();
  canvas.y -= 18;

  // --- Lines
  const hasYtd = Boolean(view.ytd);
  const amountX = hasYtd ? 470 : PAGE_W - MARGIN;
  const ytdX = PAGE_W - MARGIN;
  const qtyX = hasYtd ? 335 : 380;
  const rateX = hasYtd ? 400 : 455;
  const descW = qtyX - MARGIN - 40;

  const header = () => {
    canvas.shade(14);
    canvas.text(t.description, MARGIN + 4, 8, { bold: true, y: canvas.y + 1 });
    canvas.textRight(t.quantity, qtyX, 8, { bold: true, y: canvas.y + 1 });
    canvas.textRight(t.rate, rateX, 8, { bold: true, y: canvas.y + 1 });
    canvas.textRight(t.amount, amountX, 8, { bold: true, y: canvas.y + 1 });
    if (hasYtd) canvas.textRight(t.ytd, ytdX, 8, { bold: true, y: canvas.y + 1 });
    canvas.y -= 18;
  };
  header();

  const grouped = new Map<Section, PayslipLine[]>();
  for (const line of view.lines) {
    // Printed with the payslip-required items above, not as an amount line.
    if (line.code === 'nl.minimum_wage') continue;
    const list = grouped.get(line.section) ?? [];
    list.push(line);
    grouped.set(line.section, list);
  }

  const drawLines = (section: Section, heading: string, opts: { showAmountSign?: boolean } = {}) => {
    const lines = grouped.get(section);
    if (!lines?.length) return;
    canvas.ensure(30);
    canvas.text(heading, MARGIN + 4, 9, { bold: true });
    canvas.y -= 13;
    for (const line of lines) {
      canvas.ensure(14);
      canvas.text(canvas.fit(payslipLineLabel(line, lang), descW, 9), MARGIN + 12, 9);
      const qty = lineQuantity(line, lang);
      if (qty) canvas.textRight(qty, qtyX, 9, { color: MUTED });
      const rate = lineRate(line, lang);
      if (rate) canvas.textRight(rate, rateX, 9, { color: MUTED });
      const shown = opts.showAmountSign === false ? Math.abs(line.amountCents) : line.amountCents;
      canvas.textRight(money(shown), amountX, 9);
      if (hasYtd) {
        const ytd = view.ytd!.byLine[payslipLineKey(line)];
        if (ytd !== undefined) canvas.textRight(money(opts.showAmountSign === false ? Math.abs(ytd) : ytd), ytdX, 9, { color: MUTED });
      }
      canvas.y -= 12;
    }
    canvas.y -= 6;
  };

  const headings: Record<Section, string> = {
    earning: t.earning,
    deduction: t.deduction,
    tax: t.tax,
    reimbursement: t.reimbursement,
    employer: t.employerCosts,
    info: t.info,
  };
  for (const section of SECTION_ORDER) drawLines(section, headings[section]);
  drawLines('info', headings.info);

  // --- Summary
  canvas.ensure(120);
  canvas.rule(MARGIN, PAGE_W - MARGIN, INK, 0.8);
  canvas.y -= 16;
  const totals = view.totals;
  const ytdTotals = view.ytd?.totals;
  const summaryRows: Array<[string, Cents, Cents | undefined, boolean]> = [
    [t.gross, totals.grossCents, ytdTotals?.grossCents, false],
    [view.country === 'NL' ? t.taxableNl : t.taxableUs, totals.taxableWageCents, ytdTotals?.taxableWageCents, false],
    [t.taxes, -totals.employeeTaxesCents, ytdTotals ? -ytdTotals.employeeTaxesCents : undefined, false],
    [t.deductions, -totals.employeeDeductionsCents, ytdTotals ? -ytdTotals.employeeDeductionsCents : undefined, false],
    [t.reimbursements, totals.reimbursementsCents, ytdTotals?.reimbursementsCents, false],
  ];
  for (const [label, cents, ytd, emphasis] of summaryRows) {
    canvas.ensure(14);
    canvas.text(label, MARGIN + 4, 9, { bold: emphasis });
    canvas.textRight(money(cents), amountX, 9, { bold: emphasis });
    if (hasYtd && ytd !== undefined) canvas.textRight(money(ytd), ytdX, 9, { color: MUTED });
    canvas.y -= 13;
  }
  canvas.ensure(28);
  canvas.rule(MARGIN, PAGE_W - MARGIN, INK, 0.8);
  canvas.y -= 6;
  canvas.shade(20);
  canvas.y -= 11;
  canvas.text(t.net, MARGIN + 4, 11, { bold: true });
  canvas.textRight(money(totals.netCents), amountX, 11, { bold: true });
  if (hasYtd && ytdTotals) canvas.textRight(money(ytdTotals.netCents), ytdX, 9, { color: MUTED });
  canvas.y -= 22;

  // --- Employer costs, as a small separate table
  const employerLines = grouped.get('employer') ?? [];
  if (employerLines.length || totals.employerTaxesCents) {
    canvas.ensure(30 + employerLines.length * 12);
    canvas.text(t.employerCosts, MARGIN + 4, 8, { bold: true, color: MUTED });
    canvas.y -= 12;
    for (const line of employerLines) {
      canvas.ensure(12);
      canvas.text(canvas.fit(payslipLineLabel(line, lang), descW, 8), MARGIN + 12, 8, { color: MUTED });
      canvas.textRight(money(line.amountCents), amountX, 8, { color: MUTED });
      if (hasYtd) {
        const ytd = view.ytd!.byLine[payslipLineKey(line)];
        if (ytd !== undefined) canvas.textRight(money(ytd), ytdX, 8, { color: MUTED });
      }
      canvas.y -= 11;
    }
    canvas.text(t.employerCost, MARGIN + 12, 8, { bold: true, color: MUTED });
    canvas.textRight(money(totals.employerCostCents), amountX, 8, { bold: true, color: MUTED });
    if (hasYtd && ytdTotals) canvas.textRight(money(ytdTotals.employerCostCents), ytdX, 8, { color: MUTED });
    canvas.y -= 12;
  }

  canvas.finish(
    [`${view.employer.name} - ${title} ${view.number ?? ''}`.trim()],
    t.page,
    t.of,
  );
  return canvas.pdf.save();
}

// ---------------------------------------------------------------------------
// Generic document
// ---------------------------------------------------------------------------

export async function renderDocumentPdf(doc: PayrollDocument): Promise<Uint8Array> {
  const lang = doc.language;
  const t = TEXT[lang];
  const canvas = await newCanvas(doc.watermark, (c) => {
    c.text(doc.title, MARGIN, 9, { bold: true });
    c.y -= 8;
    c.rule();
    c.y -= 16;
  });

  canvas.text(doc.title, MARGIN, 18, { bold: true });
  canvas.y -= 16;
  if (doc.subtitle) {
    canvas.text(doc.subtitle, MARGIN, 10, { color: MUTED });
    canvas.y -= 14;
  }
  canvas.y -= 8;

  if (doc.from?.length || doc.to?.length) {
    const colW = (CONTENT_W - 20) / 2;
    const rightX = MARGIN + colW + 20;
    let leftY = canvas.y;
    let rightY = canvas.y;
    for (const [index, line] of (doc.from ?? []).entries()) {
      canvas.text(canvas.fit(line, colW, 9, index === 0), MARGIN, 9, { bold: index === 0, y: leftY });
      leftY -= 11;
    }
    for (const [index, line] of (doc.to ?? []).entries()) {
      canvas.text(canvas.fit(line, colW, 9, index === 0), rightX, 9, { bold: index === 0, y: rightY });
      rightY -= 11;
    }
    canvas.y = Math.min(leftY, rightY) - 10;
  }

  for (const section of doc.sections) {
    canvas.ensure(40);
    if (section.title) {
      canvas.text(section.title, MARGIN, 11, { bold: true });
      canvas.y -= 6;
      canvas.rule();
      canvas.y -= 14;
    }

    if (section.kind === 'fields') {
      for (const field of section.fields) {
        const valueLines = canvas.wrap(field.value, CONTENT_W - 230, 9, field.emphasis);
        canvas.ensure(valueLines.length * 12 + 2);
        canvas.text(canvas.fit(field.label, 220, 9), MARGIN, 9, { color: MUTED });
        for (const line of valueLines) {
          canvas.text(line, MARGIN + 230, 9, { bold: field.emphasis });
          canvas.y -= 12;
        }
      }
      canvas.y -= 6;
    } else if (section.kind === 'text') {
      for (const paragraph of section.paragraphs) {
        for (const line of canvas.wrap(paragraph, CONTENT_W, 9)) {
          canvas.ensure(12);
          canvas.text(line, MARGIN, 9);
          canvas.y -= 12;
        }
        canvas.y -= 4;
      }
      canvas.y -= 4;
    } else {
      const columns = section.columns.length;
      const right = new Set(section.alignRight ?? []);
      const rows = section.totals ? [...section.rows, section.totals] : section.rows;
      // Column widths from content, shrunk to fit the page.
      const gap = 10;
      const natural = section.columns.map((header, col) =>
        Math.max(canvas.width(header, 8, true), ...rows.map((row) => canvas.width(row[col] ?? '', 8.5, section.totals !== undefined && row === section.totals))),
      );
      const available = CONTENT_W - gap * (columns - 1);
      const total = natural.reduce((a, b) => a + b, 0);
      let widths = natural;
      if (total > available) {
        const fair = available / columns;
        const wide = natural.filter((w) => w > fair);
        const narrowTotal = natural.filter((w) => w <= fair).reduce((a, b) => a + b, 0);
        const wideShare = (available - narrowTotal) / Math.max(wide.length, 1);
        widths = natural.map((w) => (w > fair ? Math.max(wideShare, 30) : w));
      }
      const xs: number[] = [];
      let cursor = MARGIN;
      for (const width of widths) {
        xs.push(cursor);
        cursor += width + gap;
      }
      const drawHeader = () => {
        canvas.shade(14);
        section.columns.forEach((header, col) => {
          const text = canvas.fit(header, widths[col]!, 8, true);
          if (right.has(col)) canvas.textRight(text, xs[col]! + widths[col]!, 8, { bold: true, y: canvas.y + 1 });
          else canvas.text(text, xs[col]!, 8, { bold: true, y: canvas.y + 1 });
        });
        canvas.y -= 18;
      };
      drawHeader();
      for (const row of section.rows) {
        if (canvas.y - 12 < BOTTOM) {
          canvas.addPage();
          drawHeader();
        }
        row.forEach((cell, col) => {
          const text = canvas.fit(cell, widths[col]!, 8.5);
          if (right.has(col)) canvas.textRight(text, xs[col]! + widths[col]!, 8.5);
          else canvas.text(text, xs[col]!, 8.5);
        });
        canvas.y -= 12;
      }
      if (section.totals) {
        canvas.ensure(18);
        canvas.rule(MARGIN, PAGE_W - MARGIN, INK, 0.8);
        canvas.y -= 12;
        section.totals.forEach((cell, col) => {
          const text = canvas.fit(cell, widths[col]!, 8.5, true);
          if (right.has(col)) canvas.textRight(text, xs[col]! + widths[col]!, 8.5, { bold: true });
          else canvas.text(text, xs[col]!, 8.5, { bold: true });
        });
        canvas.y -= 12;
      }
      canvas.y -= 10;
    }
  }

  canvas.finish(doc.footer ?? [], t.page, t.of);
  return canvas.pdf.save();
}
