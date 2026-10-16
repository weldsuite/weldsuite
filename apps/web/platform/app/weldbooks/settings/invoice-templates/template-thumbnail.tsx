import { memo, useMemo } from 'react';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { PAPER_SIZES, type InvoiceTemplateDocument } from '@weldsuite/books-domain/invoice-template/schema';
import { renderPageSvg } from '@weldsuite/books-domain/invoice-template/svg';
import { cn } from '@/lib/utils';
import { useInvoiceFontFaces } from '@/lib/weldbooks/invoice-fonts';
import { useTemplateLayout } from './use-template-preview';

interface TemplateThumbnailProps {
  document: InvoiceTemplateDocument;
  data: InvoiceDocumentData;
  alt: string;
  className?: string;
}

/** First page of a template laid out with sample data. The SVG is escaped by the painter. */
export const TemplateThumbnail = memo(function TemplateThumbnail({ document, data, alt, className }: Readonly<TemplateThumbnailProps>) {
  useInvoiceFontFaces();
  const layout = useTemplateLayout(document, data);
  const html = useMemo(() => (layout ? renderPageSvg(layout, 0, { withSize: false }) : ''), [layout]);
  const paper = PAPER_SIZES[document.paperSize] ?? PAPER_SIZES.a4;
  return (
    <div
      role="img"
      aria-label={alt}
      className={cn('overflow-hidden bg-white [&>svg]:block [&>svg]:h-auto [&>svg]:w-full', className)}
      style={{ aspectRatio: `${paper.width} / ${paper.height}` }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
