/**
 * One signature request: a four-step editor for drafts (documents, recipients,
 * fields, review). Every change is saved as it is made; the fields step saves
 * its whole field set on "Save" and when you leave it.
 *
 * A draft normally opens on Documents; `?step=review` opens it on Review, which
 * is where a draft made from a template lands so it can be sent right away.
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
import { useSearchParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { EnvelopeStatusBadge } from '../components/status-badge';
import { isNotFound } from '../lib/errors';
import { DocumentsStep } from './documents-step';
import { RecipientsStep } from './recipients-step';
import { FieldsStep } from './fields-step';
import { ReviewStep } from './review-step';
import { EnvelopeOverview } from './overview';
import { EditorFrame } from './editor-frame';

const STEPS = ['documents', 'recipients', 'fields', 'review'] as const;
export type EditorStep = (typeof STEPS)[number];

export default function EnvelopePage() {
  const { envelopeId = '' } = useParams({ strict: false });
  return <EnvelopeEditor key={envelopeId} envelopeId={envelopeId} />;
}

function EnvelopeEditor({ envelopeId }: Readonly<{ envelopeId: string }>) {
  const { t } = useI18n();
  const te = t.weldsign.editor;
  const { data: envelope, isLoading, error } = useSignEnvelope(envelopeId);
  const startOnReview = useSearchParams().get('step') === 'review';
  const [step, setStep] = useState<EditorStep>(startOnReview ? 'review' : 'documents');
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

  if (envelope.status !== 'draft' && !browsing) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6">
          <h1 className="truncate px-2 text-base font-semibold">{envelope.title}</h1>
          <EnvelopeStatusBadge status={envelope.status} />
        </div>
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

  return (
    <EditorFrame
      target={targetOf(envelope)}
      title={envelope.title}
      titleLabel={te.titleLabel}
      editable={editable}
      badge={<EnvelopeStatusBadge status={envelope.status} />}
      steps={STEPS}
      stepLabels={te.steps}
      step={step}
      onStepChange={setStep}
      banner={banner}
    >
      {step === 'documents' && <DocumentsStep envelope={envelope} editable={editable} />}
      {step === 'recipients' && <RecipientsStep envelope={envelope} editable={editable} />}
      {step === 'fields' && <FieldsStep envelope={envelope} editable={editable} />}
      {step === 'review' && <ReviewStep envelope={envelope} editable={editable} />}
    </EditorFrame>
  );
}
