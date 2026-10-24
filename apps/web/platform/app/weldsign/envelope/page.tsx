/**
 * One signature request: a four-step editor for drafts (documents, recipients,
 * fields, review). Every change is saved as it is made; the fields step saves
 * its whole field set on "Save" and when you leave it.
 *
 * A request that has been sent opens read-only (its own detail view arrives in
 * phase 3 of docs/plans/weldsign.md).
 */

import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useSignEnvelope, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { EnvelopeStatusBadge } from '../components/status-badge';
import { isNotFound } from '../lib/errors';
import { DocumentsStep } from './documents-step';
import { RecipientsStep } from './recipients-step';
import { FieldsStep } from './fields-step';
import { ReviewStep } from './review-step';

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
  const [step, setStep] = useState<EditorStep>('documents');

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
  const index = STEPS.indexOf(step);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6">
        <TitleInput envelopeId={envelope.id} title={envelope.title} disabled={!editable} />
        <EnvelopeStatusBadge status={envelope.status} />
        <nav aria-label={te.titleLabel} className="ml-auto flex flex-wrap items-center gap-1">
          {STEPS.map((value, i) => (
            <button
              key={value}
              type="button"
              aria-current={step === value ? 'step' : undefined}
              onClick={() => setStep(value)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                step === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-xs tabular-nums',
                  i < index && 'border-primary bg-primary text-primary-foreground',
                  step === value && 'border-primary text-primary',
                )}
              >
                {i < index ? <Check className="size-3" /> : i + 1}
              </span>
              {te.steps[value]}
            </button>
          ))}
        </nav>
      </div>

      {!editable && <div className="border-b bg-muted/50 px-6 py-2 text-sm text-muted-foreground">{te.readOnly}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === 'documents' && <DocumentsStep envelope={envelope} editable={editable} />}
        {step === 'recipients' && <RecipientsStep envelope={envelope} editable={editable} />}
        {step === 'fields' && <FieldsStep envelope={envelope} editable={editable} />}
        {step === 'review' && <ReviewStep envelope={envelope} editable={editable} />}
      </div>

      <div className="flex items-center justify-between border-t px-4 py-3 sm:px-6">
        <Button variant="outline" size="sm" disabled={index === 0} onClick={() => setStep(STEPS[index - 1]!)}>
          <ArrowLeft />
          {te.back}
        </Button>
        {index < STEPS.length - 1 && (
          <Button size="sm" onClick={() => setStep(STEPS[index + 1]!)}>
            {te.next}
            <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The request's title, saved when the input loses focus or on Enter. */
function TitleInput({ envelopeId, title, disabled }: Readonly<{ envelopeId: string; title: string; disabled: boolean }>) {
  const { t } = useI18n();
  const update = useUpdateSignEnvelope(envelopeId);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);

  const commit = () => {
    const next = value.trim();
    if (!next) setValue(title);
    else if (next !== title) update.mutate({ title: next });
  };

  return (
    <Input
      aria-label={t.weldsign.editor.titleLabel}
      value={value}
      disabled={disabled}
      maxLength={255}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setValue(title);
          e.currentTarget.blur();
        }
      }}
      className="h-9 w-full max-w-md border-transparent px-2 text-base font-semibold shadow-none hover:border-input focus-visible:border-input sm:w-80"
    />
  );
}
