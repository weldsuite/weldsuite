import { useRef } from 'react';
import { Download } from 'lucide-react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useI18n } from '@/lib/i18n/provider';
import { saveBlob } from '@/hooks/queries/use-weldforms-results-queries';
import { qrTarget } from './embed-snippet';

const PNG_SIZE = 1024;

/** The QR code is always dark on white, whatever the theme: scanners need the contrast. */
export function QrCard({ form, shareable }: Readonly<{ form: FormDetail; shareable: boolean }>) {
  const { t } = useI18n();
  const ts = t.weldformsResults.share.qr;
  const svgBox = useRef<HTMLDivElement>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const target = shareable && form.publicUrl ? qrTarget(form.publicUrl) : null;
  const fileBase = `${slug(form.title)}-qr`;

  function downloadSvg() {
    const svg = svgBox.current?.querySelector('svg');
    if (!svg) return;
    const source = new XMLSerializer().serializeToString(svg);
    saveBlob(new Blob([source], { type: 'image/svg+xml' }), `${fileBase}.svg`);
  }

  function downloadPng() {
    const canvas = canvasBox.current?.querySelector('canvas');
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) saveBlob(blob, `${fileBase}.png`);
      else toast.error(ts.downloadFailed);
    }, 'image/png');
  }

  return (
    <SectionCard title={ts.title} description={ts.description}>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <div ref={svgBox} className="rounded-lg border bg-white p-3" role="img" aria-label={ts.alt}>
          {target ? (
            <QRCodeSVG value={target} size={168} level="M" marginSize={0} bgColor="#ffffff" fgColor="#000000" />
          ) : (
            <div className="h-[168px] w-[168px] rounded bg-muted" />
          )}
        </div>
        {target && (
          <div ref={canvasBox} className="hidden" aria-hidden>
            <QRCodeCanvas value={target} size={PNG_SIZE} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!target} onClick={downloadPng}>
            <Download className="mr-1.5 h-4 w-4" />
            {ts.downloadPng}
          </Button>
          <Button type="button" variant="outline" disabled={!target} onClick={downloadSvg}>
            <Download className="mr-1.5 h-4 w-4" />
            {ts.downloadSvg}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'form';
}
