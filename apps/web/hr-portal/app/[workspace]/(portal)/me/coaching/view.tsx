'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalPost } from '@/lib/client';
import { formatDate } from '@/lib/date';
import type { AcknowledgeResult, CoachingLog } from '@/lib/types';
import { Button, Card, PageHeader, Textarea } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

export default function CoachingView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<CoachingLog[]>(slug, '/employee/coaching');
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function acknowledge(id: string) {
    setBusyId(id);
    try {
      await portalPost<AcknowledgeResult>(slug, `/employee/coaching/${id}/acknowledge`, { comment: comment || null });
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
      <PageHeader title={dict.coaching.title} />
      {data.length === 0 ? (
        <Card>
          <EmptyState message={dict.coaching.empty} />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.map((log) => (
            <Card key={log.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm text-gray-500">{formatDate(log.sessionDate, locale, timeZone)}</p>
                  <h2 className="font-medium text-gray-900">{log.topic || log.category}</h2>
                  {log.coachName && (
                    <p className="text-xs text-gray-500">
                      {dict.coaching.coach}: {log.coachName}
                    </p>
                  )}
                </div>
                <Badge tone={log.acknowledgedAt ? 'positive' : 'neutral'}>
                  {log.acknowledgedAt ? dict.coaching.acknowledged : dict.coaching.notAcknowledged}
                </Badge>
              </div>
              {log.notes && <p className="text-sm text-gray-700 mt-3 whitespace-pre-wrap">{log.notes}</p>}
              {log.actionItems && log.actionItems.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-gray-500 mb-1">{dict.coaching.actionItems}</p>
                  <ul className="space-y-0.5 text-sm text-gray-700">
                    {log.actionItems.map((item) => (
                      <li key={item.id} className="flex items-start gap-2">
                        <span aria-hidden className="mt-0.5">{item.done ? '☑' : '☐'}</span>
                        <span className={item.done ? 'text-gray-400 line-through' : undefined}>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {log.followUpDate && (
                <p className="text-xs text-gray-500 mt-2">
                  {dict.coaching.followUp}: {formatDate(log.followUpDate, locale, timeZone)}
                </p>
              )}

              {log.acknowledgedAt ? (
                <p className="text-xs text-gray-400 mt-3">{format(dict.coaching.acknowledgedOn, { date: formatDate(log.acknowledgedAt, locale, timeZone) })}</p>
              ) : openComment === log.id ? (
                <div className="mt-3 space-y-2">
                  <Textarea
                    rows={2}
                    placeholder={dict.coaching.commentPlaceholder}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button type="button" disabled={busyId === log.id} onClick={() => void acknowledge(log.id)}>
                      {dict.coaching.acknowledge}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setOpenComment(null)}>
                      {dict.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="button" variant="secondary" className="mt-3" onClick={() => setOpenComment(log.id)}>
                  {dict.coaching.acknowledge}
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
