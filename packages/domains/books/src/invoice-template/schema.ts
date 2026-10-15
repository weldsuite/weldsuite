/**
 * Invoice template: the document a workspace designs in the invoice designer.
 *
 * A template is a page (A4 or Letter), a theme and a set of blocks placed
 * freely on the page. Coordinates are PDF points (1/72 inch) from the top-left
 * corner of the page. The layout engine (`./layout`) turns a template and an
 * invoice into positioned primitives, which the PDF painter (`./pdf`) and the
 * SVG/HTML painter (`./svg`) draw identically.
 *
 * Shared by the platform (designer + PDF download) and books-api (stored
 * template validation + the printable HTML), so it stays free of DOM and
 * Worker APIs.
 */
import { z } from 'zod';

export const INVOICE_TEMPLATE_VERSION = 1;

export const PAPER_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export type PaperSize = keyof typeof PAPER_SIZES;

/** The standard PDF fonts; HTML maps them to metric-compatible web fonts. */
export const TEMPLATE_FONTS = ['helvetica', 'times', 'courier'] as const;
export type TemplateFont = (typeof TEMPLATE_FONTS)[number];

/** A colour: `#rrggbb`, or one of the theme tokens. */
export const COLOR_TOKENS = ['accent', 'text', 'muted'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const colorSchema = z.union([hexColor, z.enum(COLOR_TOKENS)]);
export type TemplateColor = z.infer<typeof colorSchema>;

/** Images: http(s) URLs or inline data URLs, never `javascript:` and friends. */
const imageUrl = z
  .string()
  .max(500_000)
  .regex(/^(https?:\/\/|data:image\/(png|jpeg);base64,)/i);

const textStyleSchema = z.object({
  fontSize: z.number().min(5).max(72).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: colorSchema.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  /** Line height as a multiple of the font size. */
  lineHeight: z.number().min(0.8).max(3).optional(),
  uppercase: z.boolean().optional(),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

const boxStyleSchema = z.object({
  background: colorSchema.optional(),
  borderColor: colorSchema.optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  radius: z.number().min(0).max(40).optional(),
  padding: z.number().min(0).max(40).optional(),
});
export type BoxStyle = z.infer<typeof boxStyleSchema>;

/** Small caps labels above blocks ("BILL TO", "ISSUE DATE"). */
const labelStyleSchema = z.object({
  show: z.boolean().optional(),
  /** Overrides the translated label. */
  text: z.string().max(120).optional(),
  fontSize: z.number().min(5).max(36).optional(),
  color: colorSchema.optional(),
  bold: z.boolean().optional(),
  uppercase: z.boolean().optional(),
});
export type LabelStyle = z.infer<typeof labelStyleSchema>;

const baseBlock = {
  id: z.string().min(1).max(40),
  x: z.number().min(-50).max(1000),
  y: z.number().min(-50).max(1000),
  w: z.number().min(2).max(1000),
  h: z.number().min(0.5).max(1000),
  /** Painted on every page (letterhead, footer band, page number). */
  everyPage: z.boolean().optional(),
  /** Hidden from the output; kept in the template. */
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  box: boxStyleSchema.optional(),
};

/** Values a `field` block or a `{{placeholder}}` can print. */
export const TEMPLATE_FIELDS = [
  'title',
  'invoiceNumber',
  'issueDate',
  'dueDate',
  'reference',
  'placeOfSupply',
  'currency',
  'total',
  'balanceDue',
  'amountPaid',
  'paymentTerms',
  'customerName',
  'customerEmail',
  'customerTaxId',
  'sellerName',
  'sellerLegalName',
  'sellerEmail',
  'sellerPhone',
  'sellerWebsite',
  'sellerTaxId',
  'sellerRegistrationId',
  'sellerIban',
  'sellerBic',
  'footerText',
] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

/** Columns the line-items table can show; data decides which exist for an invoice. */
export const LINE_ITEM_COLUMNS = [
  'index',
  'description',
  'hsnSac',
  'quantity',
  'unit',
  'unitPrice',
  'discount',
  'taxRate',
  'taxAmount',
  'amount',
  'amountWithTax',
] as const;
export type LineItemColumnKey = (typeof LINE_ITEM_COLUMNS)[number];

const lineItemColumnSchema = z.object({
  key: z.enum(LINE_ITEM_COLUMNS),
  /** Relative width; the description column takes what is left when 0. */
  width: z.number().min(0).max(100),
  label: z.string().max(60).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});
export type LineItemColumn = z.infer<typeof lineItemColumnSchema>;

const textBlock = z.object({
  ...baseBlock,
  type: z.literal('text'),
  /** Static text; `{{invoiceNumber}}` style placeholders take any TEMPLATE_FIELDS value. */
  text: z.string().max(5000),
  style: textStyleSchema.optional(),
});

const fieldBlock = z.object({
  ...baseBlock,
  type: z.literal('field'),
  field: z.enum(TEMPLATE_FIELDS),
  /** `stacked`: label above value; `inline`: label left, value right. */
  layout: z.enum(['stacked', 'inline', 'value']).optional(),
  label: labelStyleSchema.optional(),
  style: textStyleSchema.optional(),
});

const logoBlock = z.object({
  ...baseBlock,
  type: z.literal('logo'),
  align: z.enum(['left', 'center', 'right']).optional(),
  /** Printed when the entity has no logo; falls back to the entity name. */
  fallbackStyle: textStyleSchema.optional(),
});

const imageBlock = z.object({
  ...baseBlock,
  type: z.literal('image'),
  src: imageUrl,
  align: z.enum(['left', 'center', 'right']).optional(),
});

const partyBlockBase = {
  ...baseBlock,
  label: labelStyleSchema.optional(),
  style: textStyleSchema.optional(),
  /** First line (the name) bold. */
  boldName: z.boolean().optional(),
  /** Everything on one wrapped line, separated by " · " (footers). */
  inline: z.boolean().optional(),
};

const sellerBlock = z.object({
  ...partyBlockBase,
  type: z.literal('seller'),
  showContact: z.boolean().optional(),
  showTaxIds: z.boolean().optional(),
});

const billToBlock = z.object({
  ...partyBlockBase,
  type: z.literal('billTo'),
  showEmail: z.boolean().optional(),
});

const shipToBlock = z.object({
  ...partyBlockBase,
  type: z.literal('shipTo'),
});

const lineItemsBlock = z.object({
  ...baseBlock,
  type: z.literal('lineItems'),
  columns: z.array(lineItemColumnSchema).min(1).max(12),
  fontSize: z.number().min(5).max(16).optional(),
  header: z
    .object({
      background: colorSchema.optional(),
      color: colorSchema.optional(),
      bold: z.boolean().optional(),
      uppercase: z.boolean().optional(),
      fontSize: z.number().min(5).max(16).optional(),
      /** Rule under the header row. */
      rule: colorSchema.optional(),
    })
    .optional(),
  rowRule: colorSchema.optional(),
  /** Background of every other row. */
  zebra: colorSchema.optional(),
  rowPadding: z.number().min(0).max(16).optional(),
});

const totalsBlock = z.object({
  ...baseBlock,
  type: z.literal('totals'),
  style: textStyleSchema.optional(),
  /** The grand total row. */
  total: z
    .object({
      fontSize: z.number().min(5).max(36).optional(),
      color: colorSchema.optional(),
      background: colorSchema.optional(),
      rule: colorSchema.optional(),
    })
    .optional(),
  showBalance: z.boolean().optional(),
});

const paymentBlock = z.object({
  ...baseBlock,
  type: z.literal('payment'),
  label: labelStyleSchema.optional(),
  style: textStyleSchema.optional(),
  showInstructions: z.boolean().optional(),
  showBank: z.boolean().optional(),
});

const notesBlock = z.object({
  ...baseBlock,
  type: z.literal('notes'),
  label: labelStyleSchema.optional(),
  style: textStyleSchema.optional(),
});

const termsBlock = z.object({
  ...baseBlock,
  type: z.literal('terms'),
  label: labelStyleSchema.optional(),
  style: textStyleSchema.optional(),
  /** Overrides the entity's terms and conditions for this template. */
  text: z.string().max(5000).optional(),
});

/** Compliance notices, exempt-sale notice, fiscal document, Pix QR, required footer. */
const legalBlock = z.object({
  ...baseBlock,
  type: z.literal('legal'),
  style: textStyleSchema.optional(),
});

const rectBlock = z.object({
  ...baseBlock,
  type: z.literal('rect'),
});

const lineBlock = z.object({
  ...baseBlock,
  type: z.literal('line'),
  color: colorSchema.optional(),
  thickness: z.number().min(0.25).max(10).optional(),
  orientation: z.enum(['horizontal', 'vertical']).optional(),
});

const pageNumberBlock = z.object({
  ...baseBlock,
  type: z.literal('pageNumber'),
  style: textStyleSchema.optional(),
});

export const templateBlockSchema = z.discriminatedUnion('type', [
  textBlock,
  fieldBlock,
  logoBlock,
  imageBlock,
  sellerBlock,
  billToBlock,
  shipToBlock,
  lineItemsBlock,
  totalsBlock,
  paymentBlock,
  notesBlock,
  termsBlock,
  legalBlock,
  rectBlock,
  lineBlock,
  pageNumberBlock,
]);
export type TemplateBlock = z.infer<typeof templateBlockSchema>;
export type TemplateBlockType = TemplateBlock['type'];
export type BlockOf<T extends TemplateBlockType> = Extract<TemplateBlock, { type: T }>;

export const templateThemeSchema = z.object({
  font: z.enum(TEMPLATE_FONTS),
  accent: hexColor,
  text: hexColor,
  muted: hexColor,
  /** Default font size of body text. */
  fontSize: z.number().min(6).max(14),
});
export type TemplateTheme = z.infer<typeof templateThemeSchema>;

export const invoiceTemplateDocumentSchema = z
  .object({
    version: z.literal(INVOICE_TEMPLATE_VERSION),
    paperSize: z.enum(['a4', 'letter']),
    /** Where continuation pages start and the line items stop. */
    margins: z.object({
      top: z.number().min(0).max(300),
      bottom: z.number().min(0).max(300),
    }),
    theme: templateThemeSchema,
    blocks: z.array(templateBlockSchema).max(200),
  })
  .superRefine((doc, ctx) => {
    const tables = doc.blocks.filter((b) => b.type === 'lineItems');
    if (tables.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks'], message: 'A template has exactly one line-items table' });
    }
    if (tables[0]?.everyPage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks'], message: 'The line-items table cannot repeat on every page' });
    }
    if (tables[0]?.hidden) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks'], message: 'The line-items table cannot be hidden' });
    }
    const ids = new Set<string>();
    for (const block of doc.blocks) {
      if (ids.has(block.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks'], message: `Duplicate block id ${block.id}` });
      }
      ids.add(block.id);
    }
  });
export type InvoiceTemplateDocument = z.infer<typeof invoiceTemplateDocumentSchema>;

/** API: create / update a stored template. */
export const createInvoiceTemplateSchema = z.object({
  entityId: z.string().min(1).max(30),
  name: z.string().trim().min(1).max(120),
  isDefault: z.boolean().optional(),
  document: invoiceTemplateDocumentSchema,
});
export type CreateInvoiceTemplateInput = z.infer<typeof createInvoiceTemplateSchema>;

export const updateInvoiceTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isDefault: z.boolean().optional(),
  document: invoiceTemplateDocumentSchema.optional(),
});
export type UpdateInvoiceTemplateInput = z.infer<typeof updateInvoiceTemplateSchema>;

/** A stored template as the API returns it. */
export interface InvoiceTemplate {
  id: string;
  entityId: string;
  name: string;
  isDefault: boolean;
  document: InvoiceTemplateDocument;
  createdAt: string;
  updatedAt: string;
}
