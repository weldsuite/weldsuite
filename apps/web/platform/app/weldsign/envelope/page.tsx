/**
 * One signature request. A draft opens in the request editor: its documents on
 * the left, everything else on the right, as an invoice is edited in WeldBooks.
 *
 * A request that has been sent opens on its status view (progress, reminders,
 * voiding, activity); its documents and fields can still be browsed read-only.
 */

import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { useSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { EnvelopeStatusBadge } from '../components/status-badge';
import { isNotFound } from '../lib/errors';
import { EnvelopeOverview } from './overview';
import { EditorHeader } from './editor-frame';
import { RequestEditor } from './request-editor';

export default function EnvelopePage() {
  const { envelopeId = '' } = useParams({ strict: false });
  return <EnvelopeEditor key={envelopeId} envelopeId={envelopeId} />;
}

function EnvelopeEditor({ envelopeId }: Readonly<{ envelopeId: string }>) {
  const { t } = useI18n();
  const te = t.weldsign.editor;
  const { data: envelope, isLoading, error } = useSignEnvelope(envelopeId);
  // A sent request opens on its status; its documents and fields can still be browsed.
  const [browsing, setBrowsing] = useState(false);

  useBreadcrumbs(
    [
      { label: t.weldsign.breadcrumb.home, href: '/weldsign' },
      { label: envelope?.title ?? '…' },
    ],
    { enabled: !!envelope },
  );

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error || !envelope) {
    return <div className="p-10 text-center text-muted-foreground">{isNotFound(error) ? te.notFound : te.loadFailed}</div>;
  }

  const editable = envelope.canEdit;
  const back = { to: '/weldsign', label: te.backHome };

  if (envelope.status !== 'draft' && !browsing) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader title={envelope.title} back={back} badge={<EnvelopeStatusBadge status={envelope.status} />} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EnvelopeOverview envelope={envelope} onViewDocuments={() => setBrowsing(true)} />
        </div>
      </div>
    );
  }

  const banner = editable ? null : (
    <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-6 py-2 text-sm text-muted-foreground">
      <span>{te.readOnly}</span>
      {envelope.status !== 'draft' && (
        <Button variant="ghost" size="sm" onClick={() => setBrowsing(false)}>
          <ArrowLeft />
          {te.back}
        </Button>
      )}
    </div>
  );

  return <RequestEditor envelope={envelope} editable={editable} back={back} banner={banner} />;
}
