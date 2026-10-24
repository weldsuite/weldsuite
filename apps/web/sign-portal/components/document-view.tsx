'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@weldsuite/ui/components/button';
import type { SignPortalEnvelope } from '@weldsuite/app-api-client/schemas/weldsign';
import type { SigningState } from '@/lib/fields';
import { openPdf } from '@/lib/pdf';
import { portalBytes } from '@/lib/portal-client';
import { FieldBox } from './field-box';
import { PdfPage } from './pdf-page';
import { usePortal } from './portal-context';

type PortalDocument = SignPortalEnvelope['documents'][number];

interface DocumentViewProps {
  envelope: SignPortalEnvelope;
  state: SigningState;
  /** Wraps a request so an expired session is renewed and the request retried once. */
  withSession: <T>(run: () => Promise<T>) => Promise<T>;
  autoText: (type: 'name' | 'email' | 'date_signed') => string;
  highlightedId: string | null;
  register: (id: string, el: HTMLElement | null) => void;
  onValue: (id: string, value: string) => void;
  onAdopt: (kind: 'signature' | 'initials') => void;
}

/** Every document of the envelope, every page, with the signer's fields on top. */
export function DocumentView({ envelope, state, withSession, autoText, highlightedId, register, onValue, onAdopt }: Readonly<DocumentViewProps>) {
  const { t } = usePortal();
  const showNames = envelope.documents.length > 1;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-2 py-4 sm:px-4">
      {envelope.documents.map((doc) => (
        <section key={doc.id} className="flex flex-col gap-3" aria-label={doc.name}>
          {showNames ? <h2 className="px-1 text-sm font-semibold">{doc.name}</h2> : null}
          <DocumentPages
            doc={doc}
            envelope={envelope}
            state={state}
            withSession={withSession}
            autoText={autoText}
            highlightedId={highlightedId}
            register={register}
            onValue={onValue}
            onAdopt={onAdopt}
            pageLabel={(n) => t.sign.page(n, doc.pageCount)}
          />
        </section>
      ))}
    </div>
  );
}

type DocumentPagesProps = Omit<DocumentViewProps, never> & { doc: PortalDocument; pageLabel: (n: number) => string };

function DocumentPages({ doc, envelope, state, withSession, autoText, highlightedId, register, onValue, onAdopt, pageLabel }: Readonly<DocumentPagesProps>) {
  const { t } = usePortal();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setFailed(false);
    setPdf(null);
    void (async () => {
      try {
        const bytes = await withSession(() => portalBytes(`/api/portal/documents/${encodeURIComponent(doc.id)}`));
        const document = await openPdf(bytes);
        if (cancelled) {
          void document.destroy();
          return;
        }
        opened = document;
        setPdf(document);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void opened.destroy();
    };
    // `withSession` is stable per flow; a retry bumps `attempt`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, attempt]);

  const fieldsOn = useCallback((pageIndex: number) => envelope.fields.filter((f) => f.documentId === doc.id && f.page === pageIndex), [envelope.fields, doc.id]);

  return (
    <>
      {failed ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border bg-card p-5 text-center text-sm">
          <p>{t.sign.pdfFailed}</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t.sign.pdfRetry}
          </Button>
        </div>
      ) : null}
      {!failed && !pdf ? (
        <p role="status" className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {t.sign.pdfLoading}
        </p>
      ) : null}
      {doc.pageSizes.map((size, pageIndex) => (
        <figure key={pageIndex} className="m-0 flex flex-col gap-1">
          <PdfPage pdf={pdf} pageIndex={pageIndex} size={size} label={pageLabel(pageIndex + 1)}>
            {(scale) =>
              fieldsOn(pageIndex).map((field) => (
                <FieldBox
                  key={field.id}
                  field={field}
                  scale={scale}
                  page={size}
                  state={state}
                  autoText={field.type === 'name' || field.type === 'email' || field.type === 'date_signed' ? autoText(field.type) : ''}
                  highlighted={highlightedId === field.id}
                  register={register}
                  onValue={onValue}
                  onAdopt={onAdopt}
                />
              ))
            }
          </PdfPage>
          <figcaption className="text-center text-xs text-muted-foreground">{pageLabel(pageIndex + 1)}</figcaption>
        </figure>
      ))}
    </>
  );
}
