import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { pageDisplay } from '@weldsuite/docs-engine';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { PageContent } from './view/page-content';

/**
 * Every page, at its real size, for the browser's print dialog: rendered
 * only while printing, and the only thing visible on paper.
 */
export function PrintView({ controller }: { controller: DocController }) {
  const { language } = useI18n();
  const pages = controller.pages;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const displays = useMemo(() => pages.map((p) => pageDisplay(controller.layout, p, { title: controller.options.title, locale: language })), [pages, language]);
  const first = pages[0];

  useEffect(() => {
    const done = () => controller.setPrinting(false);
    window.addEventListener('afterprint', done);
    // Give the browser a frame to lay the pages out before the dialog snapshots them.
    const timer = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', done);
    };
  }, [controller]);

  if (!first) return null;
  return createPortal(
    <div className="welddocs-print" aria-hidden>
      <style>{`
        @media screen { .welddocs-print { position: fixed; left: -100000px; top: 0; } }
        @media print {
          body > *:not(.welddocs-print) { display: none !important; }
          .welddocs-print { display: block; }
          @page { size: ${first.width}pt ${controller.doc.props.pageless ? 'auto' : `${first.height}pt`}; margin: 0; }
        }
        .welddocs-print-page { position: relative; overflow: hidden; break-after: page; page-break-after: always; }
      `}</style>
      {pages.map((p, i) => (
        <div key={i} className="welddocs-print-page" style={{ width: `${p.width}pt`, height: `${p.height}pt`, background: p.section.background ?? '#ffffff' }}>
          <PageContent items={displays[i]!} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
