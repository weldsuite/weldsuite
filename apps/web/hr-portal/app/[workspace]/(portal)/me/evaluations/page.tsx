'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalPost } from '@/lib/client';
import { formatDate } from '@/lib/date';
import type { AcknowledgeResult, Evaluation } from '@/lib/types';
import { Button, Card, PageHeader, Textarea } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

export default function EvaluationsPage() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<Evaluation[]>(slug, '/employee/evaluations');
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function acknowledge(id: string) {
    setBusyId(id);
    try {
      await portalPost<AcknowledgeResult>(slug, `/employee/evaluations/${id}/acknowledge`, { comment: comment || null });
      setOpenComment(null);
      setComment('');
      refetch();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.evaluations.title} />
      {data.length === 0 ? (
        <Card>
          <EmptyState message={dict.evaluations.empty} />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.map((ev) => (
            <Card key={ev.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-medium text-gray-900">{ev.formName || dict.evaluations.title}</h2>
                  {ev.periodStart && ev.periodEnd && (
                    <p className="text-sm text-gray-500">{format(dict.performance.period, { start: formatDate(ev.periodStart, locale), end: formatDate(ev.periodEnd, locale) })}</p>
                  )}
                  {ev.evaluatorName && (
                    <p className="text-xs text-gray-500">
                      {dict.evaluations.evaluator}: {ev.evaluatorName}
                    </p>
                  )}
                </div>
                {ev.overallScore !== null && (
                  <Badge tone="info">
                    {dict.evaluations.overallScore}: {ev.overallScore}
                  </Badge>
                )}
              </div>

              {ev.criteria && ev.criteria.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-gray-500">{dict.evaluations.criteria}</p>
                  {ev.criteria.map((c) => {
                    const scored = ev.scores.find((s) => s.criterionId === c.id);
                    return (
                      <div key={c.id}>
                        <ProgressBar value={scored?.score ?? 0} max={c.maxScore} label={c.label} />
                        {scored?.comment && <p className="mt-0.5 text-xs text-gray-500">{scored.comment}</p>}
                      </div>
                    );
                  })}
                </div>
              )}

              {ev.summary && (
                <div className="mt-4">
                  <p className="text-xs font-medium text-gray-500 mb-1">{dict.evaluations.summary}</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{ev.summary}</p>
                </div>
              )}

              {ev.acknowledgedAt ? (
                <p className="text-xs text-gray-400 mt-3">{format(dict.evaluations.acknowledgedOn, { date: formatDate(ev.acknowledgedAt, locale) })}</p>
              ) : ev.status === 'submitted' ? (
                openComment === ev.id ? (
                  <div className="mt-3 space-y-2">
                    <Textarea rows={2} placeholder={dict.evaluations.commentPlaceholder} value={comment} onChange={(e) => setComment(e.target.value)} />
                    <div className="flex gap-2">
                      <Button type="button" disabled={busyId === ev.id} onClick={() => void acknowledge(ev.id)}>
                        {dict.evaluations.acknowledge}
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setOpenComment(null)}>
                        {dict.common.cancel}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button type="button" variant="secondary" className="mt-3" onClick={() => setOpenComment(ev.id)}>
                    {dict.evaluations.acknowledge}
                  </Button>
                )
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
