'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalPost } from '@/lib/client';
import { formatDate } from '@/lib/date';
import type { CompleteTaskResult, EmployeeTask } from '@/lib/types';
import { Card, PageHeader } from '@/components/ui/primitives';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

export default function TasksView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, format, timeZone } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<EmployeeTask[]>(slug, '/employee/tasks');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(task: EmployeeTask) {
    setBusyId(task.id);
    try {
      const undo = Boolean(task.completedAt);
      await portalPost<CompleteTaskResult>(slug, `/employee/tasks/${task.id}/complete${undo ? '?undo=true' : ''}`);
      refetch();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.tasks.title} />
      {data.length === 0 ? (
        <Card>
          <EmptyState message={dict.tasks.empty} />
        </Card>
      ) : (
        <Card className="divide-y divide-gray-100">
          {data.map((task) => (
            <div key={task.id} className="py-3 flex items-start gap-3">
              <input
                type="checkbox"
                checked={Boolean(task.completedAt)}
                disabled={!task.canComplete || busyId === task.id}
                onChange={() => void toggle(task)}
                className="mt-1 h-5 w-5 shrink-0"
                aria-label={task.title}
              />
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${task.completedAt ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{task.title}</p>
                {task.description && <p className="text-sm text-gray-500 mt-0.5">{task.description}</p>}
                <p className="text-xs text-gray-400 mt-1">
                  {task.completedAt
                    ? format(dict.tasks.completedOn, { date: formatDate(task.completedAt, locale, timeZone) })
                    : task.dueDate
                      ? format(dict.tasks.due, { date: formatDate(task.dueDate, locale, timeZone) })
                      : dict.tasks.noDueDate}
                  {!task.canComplete && !task.completedAt && ` · ${dict.tasks.notYours}`}
                </p>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
