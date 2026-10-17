/**
 * The live preview of the invoice form: the form's current state laid out
 * with the template it will print with (the chosen one, else the company's
 * default, else the classic preset) and painted page by page as SVG, the way
 * the invoice-template designer shows a template.
 */

import { memo, useDeferredValue, useMemo, useRef } from 'react';
import { layoutInvoice } from '@weldsuite/books-domain/invoice-template/layout';
import { presetTemplate } from '@weldsuite/books-domain/invoice-template/presets';
import { renderPageSvg } from '@weldsuite/books-domain/invoice-template/svg';
import { PAPER_SIZES } from '@weldsuite/books-domain/invoice-template/schema';
import { useAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import { useInvoiceTemplates } from '@/hooks/queries/use-invoice-template-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type {
  InvoiceWithTax,
  TaxPreviewLine,
  TaxPreviewResult,
} from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { invoicePaperSize, type InvoicePdfEntity } from '@/lib/weldbooks/invoice-pdf';
import { buildInvoiceDocumentData } from '@/lib/weldbooks/invoice-template-data';
import { useCountryLabel } from '@/lib/weldbooks/use-country-label';
import { useInvoiceDocumentLabels } from '@/lib/weldbooks/use-invoice-template-labels';
import { cn } from '@/lib/utils';

interface PreviewAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  county?: string;
}

/** The parts of the form's values the preview prints. */
export interface InvoicePreviewValues {
  issueDate?: string;
  dueDate?: string;
  reference?: string;
  notes?: string;
  currency?: string;
  templateId?: string | null;
  placeOfSupply?: string;
  billingAddress?: PreviewAddress;
  shipToDifferent?: boolean;
  shippingAddress?: PreviewAddress;
  items?: Array<{
    description?: string;
    quantity?: number | string;
    unitPrice?: number | string;
    unit?: string;
    hsnSac?: string;
    discountPercent?: number | string;
    taxRateId?: string | null;
  }>;
}

interface InvoicePreviewProps {
  values: InvoicePreviewValues;
  /** The invoice being edited; absent on a new one. */
  invoice?: Pick<InvoiceWithTax, 'id' | 'invoiceNumber' | 'type' | 'status' | 'creditNoteForInvoiceId'>;
  customer: { name: string; email: string } | null;
  /** The server's calculation of the form (totals, per-line tax, breakdown); null until it answers. */
  calculation: TaxPreviewResult | null;
  /** Shown as the number while the invoice has none yet. */
  numberPlaceholder: string;
  className?: string;
}

const money = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : '0.00');

/** Blank address fields are left out, so an empty address prints nothing. */
function compactAddress(address: PreviewAddress | undefined): PreviewAddress | null {
  const entries = Object.entries(address ?? {}).filter(([, value]) => typeof value === 'string' && value.trim() !== '');
  return entries.length > 0 ? (Object.fromEntries(entries) as PreviewAddress) : null;
}

/** The form's state as the invoice row the PDF builders read. */
function draftInvoice(
  { values, invoice, customer, calculation, numberPlaceholder }: Readonly<InvoicePreviewProps>,
): InvoiceWithTax {
  const lineOf = (index: number): TaxPreviewLine | undefined => calculation?.lines.find((line) => line.index === index);
  const items = (values.items ?? []).map((item, index) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const discount = Number(item.discountPercent) || 0;
    const calculated = lineOf(index);
    const lineTotal = calculated ? Number(calculated.lineTotal) : quantity * unitPrice * (1 - discount / 100);
    const taxAmount = calculated ? Number(calculated.taxAmount) : 0;
    return {
      id: `draft-${index}`,
      invoiceId: invoice?.id ?? 'draft',
      description: item.description ?? '',
      quantity: String(quantity),
      unitPrice: money(unitPrice),
      unit: item.unit || null,
      discountPercent: discount ? String(discount) : null,
      taxRateId: item.taxRateId ?? null,
      taxRate: calculated?.taxRate ?? null,
      taxAmount: money(taxAmount),
      lineTotal: money(lineTotal),
      lineTotalWithTax: money(lineTotal + taxAmount),
      accountId: null,
      sortOrder: index,
      hsnSac: item.hsnSac || null,
    };
  });
  const subtotal = calculation ? Number(calculation.subtotal) : items.reduce((sum, item) => sum + Number(item.lineTotal), 0);
  const taxTotal = calculation ? Number(calculation.taxTotal) : 0;
  const total = calculation ? Number(calculation.total) : subtotal;

  return {
    id: invoice?.id ?? 'draft',
    invoiceNumber: invoice?.invoiceNumber ?? numberPlaceholder,
    type: invoice?.type ?? 'standard',
    status: invoice?.status ?? 'draft',
    creditNoteForInvoiceId: invoice?.creditNoteForInvoiceId ?? null,
    contactName: customer?.name ?? '',
    contactEmail: customer?.email ?? '',
    issueDate: values.issueDate ?? null,
    dueDate: values.dueDate ?? null,
    currency: values.currency || null,
    subtotal: money(subtotal),
    taxTotal: money(taxTotal),
    total: money(total),
    amountPaid: '0',
    balanceDue: money(total),
    reference: values.reference || null,
    notes: values.notes || null,
    internalNotes: null,
    placeOfSupply: values.placeOfSupply || null,
    billingAddress: compactAddress(values.billingAddress),
    shippingAddress: values.shipToDifferent ? compactAddress(values.shippingAddress) : null,
    taxBreakdown: calculation?.taxBreakdown ?? null,
    items,
    payments: [],
  } as unknown as InvoiceWithTax;
}

/**
 * The previous reference while the value serialises the same. The form hands
 * over fresh objects on every keystroke; this keeps the layout below from
 * rerunning unless something it prints changed.
 */
function useStableValue<T>(value: T): T {
  const ref = useRef<{ json: string; value: T } | null>(null);
  const json = JSON.stringify(value);
  if (ref.current?.json !== json) ref.current = { json, value };
  return ref.current.value;
}

/** One sheet of paper: the painted SVG of a page. The SVG is escaped by the painter. */
const PreviewPage = memo(function PreviewPage({ svg, aspect }: Readonly<{ svg: string; aspect: string }>) {
  return (
    <div
      className="w-full overflow-hidden rounded-none bg-white shadow-md ring-1 ring-black/5 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
      style={{ aspectRatio: aspect }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

export function InvoicePreview(props: Readonly<InvoicePreviewProps>) {
  const { entityId } = useCurrentAccountingEntity();
  const { data: entity } = useAccountingEntity(entityId);
  const { data: templates } = useInvoiceTemplates(entityId);
  const documentLabels = useInvoiceDocumentLabels();
  const countryName = useCountryLabel();

  // Typing stays responsive: the preview catches up once React has a moment.
  const { values, invoice, customer, calculation, numberPlaceholder } = props;
  const input = useStableValue({ values, invoice, customer, calculation, numberPlaceholder });
  const deferred = useDeferredValue(input);
  const pdfEntity = entity as InvoicePdfEntity | undefined;

  const document = useMemo(() => {
    const chosen =
      templates?.find((template) => template.id === deferred.values.templateId) ??
      templates?.find((template) => template.isDefault);
    if (chosen) return chosen.document;
    return presetTemplate('classic', pdfEntity ? invoicePaperSize(pdfEntity) : 'a4');
  }, [templates, deferred.values.templateId, pdfEntity]);

  const pages = useMemo(() => {
    if (!pdfEntity) return [];
    try {
      const data = buildInvoiceDocumentData(
        draftInvoice(deferred),
        pdfEntity,
        {
          pdfLabels: documentLabels.pdfLabels,
          labels: documentLabels.labels,
          formatDate: documentLabels.formatDate,
          countryName,
        },
        deferred.customer ?? undefined,
      );
      const layout = layoutInvoice(document, data);
      return layout.pages.map((_, index) => renderPageSvg(layout, index, { withSize: false }));
    } catch {
      return [];
    }
    // The label objects are rebuilt every render; the stable input and the template drive the preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, document, pdfEntity]);

  const paper = PAPER_SIZES[document.paperSize] ?? PAPER_SIZES.a4;
  const aspect = `${paper.width} / ${paper.height}`;

  return (
    <div className={cn('mx-auto flex w-full max-w-[820px] flex-col gap-6', props.className)} data-testid="invoice-preview">
      {pages.length === 0 ? (
        <div className="w-full animate-pulse rounded-none bg-white/80 shadow-md" style={{ aspectRatio: aspect }} />
      ) : (
        pages.map((svg, index) => <PreviewPage key={index} svg={svg} aspect={aspect} />)
      )}
    </div>
  );
}
