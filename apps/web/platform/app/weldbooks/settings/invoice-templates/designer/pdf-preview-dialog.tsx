import { useEffect, useState } from 'react';
import { AlertCircle, Download, Loader2 } from 'lucide-react';
import type { InvoiceLayout } from '@weldsuite/books-domain/invoice-template/layout';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useI18n } from '@/lib/i18n/provider';

type PreviewState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' };

interface PdfPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current draft laid out with the sample invoice. */
  layout: InvoiceLayout | null;
}

/** The draft as a real PDF in a frame, with a download. The PDF engine loads on first use. */
export function PdfPreviewDialog({ open, onOpenChange, layout }: Readonly<PdfPreviewDialogProps>) {
  const { t } = useI18n();
  const tp = t.accounting.invoiceTemplates.preview;
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    if (!open || !layout) return;
    let cancelled = false;
    let url: string | null = null;
    setState({ status: 'loading' });
    (async () => {
      try {
        const [{ renderInvoicePdf }, { loadInvoiceFont }] = await Promise.all([
          import('@weldsuite/books-domain/invoice-template/pdf'),
          import('@/lib/weldbooks/invoice-fonts'),
        ]);
        const bytes = await renderInvoicePdf(layout, { loadFont: loadInvoiceFont });
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
        setState({ status: 'ready', url });
      } catch (err) {
        console.error('[invoice-template] preview failed', err);
        if (!cancelled) setState({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, layout]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] flex-col gap-3 sm:max-w-5xl">
        <DialogHeader className="pr-8">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <DialogTitle>{tp.title}</DialogTitle>
              <DialogDescription>{tp.description}</DialogDescription>
            </div>
            {state.status === 'ready' ? (
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <a href={state.url} download={`${tp.filename}.pdf`}>
                  <Download aria-hidden />
                  {tp.download}
                </a>
              </Button>
            ) : null}
          </div>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-muted/40">
          {state.status === 'loading' ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {tp.generating}
            </div>
          ) : null}
          {state.status === 'error' ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground" role="alert">
              <AlertCircle className="h-6 w-6 text-destructive" aria-hidden />
              {tp.failed}
            </div>
          ) : null}
          {state.status === 'ready' ? <iframe title={tp.title} src={state.url} className="h-full w-full border-0 bg-white" /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
