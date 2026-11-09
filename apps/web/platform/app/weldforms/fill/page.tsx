/**
 * Fill in a members-only form inside the platform (`/weldforms/fill/:publicId`).
 * The renderer runs in `live` mode and submits through `submitFill`, as the
 * signed-in member: no code, no bot check; files go to the member's unfinished
 * response (`uploadFill`). A member who already answered a
 * one-per-member form sees that instead of the form.
 */

import { useMemo } from 'react';
import { useParams } from '@tanstack/react-router';
import { CircleCheck, FileQuestion, Lock } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { FormRenderer, type SubmitFieldErrors, type SubmitPayload, type SubmitResult } from '@weldsuite/forms-renderer';
import '@weldsuite/forms-renderer/styles.css';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { useMemberFill, useSubmitMemberFill, useUploadMemberFile } from '@/hooks/queries/use-weldforms-results-queries';
import { getRendererLabels } from '../lib/renderer-labels';
import { fieldErrorsOf } from './field-errors';

export default function FillPage() {
  const { publicId = '' } = useParams({ strict: false });
  return <FillContent key={publicId} publicId={publicId} />;
}

function FillContent({ publicId }: Readonly<{ publicId: string }>) {
  const { t } = useI18n();
  const tf = t.weldformsResults.fill;
  const query = useMemberFill(publicId);
  const submit = useSubmitMemberFill(publicId);
  const upload = useUploadMemberFile(publicId);
  const fill = query.data;
  const definition = fill?.form.definition ?? null;
  const labels = useMemo(
    () => (definition ? getRendererLabels(definition.presentation.language) : null),
    [definition],
  );

  async function onSubmit(payload: SubmitPayload): Promise<SubmitResult | SubmitFieldErrors> {
    try {
      const res = await submit.mutateAsync({ answers: payload.answers, timings: payload.timings });
      return res.data;
    } catch (err) {
      const fieldErrors = fieldErrorsOf(err);
      if (fieldErrors) return { fieldErrors };
      throw err;
    }
  }

  const backLink = (
    <Button asChild variant="outline">
      <Link href="/weldforms">{tf.back}</Link>
    </Button>
  );

  if (query.isLoading) return <PageLoader fullScreen={false} />;

  if (query.error || !fill) {
    if (isApiError(query.error) && query.error.status === 404) {
      return (
        <div className="p-6">
          <EmptyState icon={FileQuestion} title={tf.notFoundTitle} description={tf.notFoundDescription} action={backLink} />
        </div>
      );
    }
    return (
      <div className="p-6">
        <ErrorState message={tf.loadFailed} onRetry={() => void query.refetch()} retryLabel={t.weldformsResults.common.retry} />
      </div>
    );
  }

  if (fill.alreadyResponded) {
    return (
      <div className="p-6">
        <EmptyState icon={CircleCheck} title={tf.alreadyTitle} description={tf.alreadyDescription} action={backLink} />
      </div>
    );
  }

  if (fill.form.state !== 'open' || !definition || !labels) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Lock}
          title={tf.notOpenTitle}
          description={fill.form.closedMessage ?? tf.closedStates[fill.form.state]}
          action={backLink}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-[70vh] w-full max-w-3xl p-0 sm:p-4">
      <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
        <FormRenderer
          definition={definition}
          theme={fill.form.theme}
          labels={labels}
          mode="live"
          embedded
          onUpload={(fieldId, file) => upload.mutateAsync({ fieldId, file })}
          onSubmit={onSubmit}
          className="min-h-[70vh]"
        />
      </div>
    </div>
  );
}
