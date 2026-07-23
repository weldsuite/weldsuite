
import { useEffect } from 'react';
import { SummaryClient } from './summary-client';
import { PageLoader } from '@/components/page-loader';
import { useInboxSummary } from '@/hooks/queries/use-mail-queries';

const categoryColors: Record<string, string> = {
  Work: 'bg-blue-500 dark:bg-blue-600',
  Personal: 'bg-green-500 dark:bg-green-600',
  Finance: 'bg-purple-500 dark:bg-purple-600',
  Notifications: 'bg-orange-500 dark:bg-orange-600',
  Other: 'bg-gray-500 dark:bg-border',
};

const emptySummary = {
  totalEmails: 0,
  unread: 0,
  important: 0,
  requiresAction: 0,
  categories: [] as Array<{ name: string; count: number; color: string }>,
  topSenders: [] as Array<{ name: string; email: string; count: number }>,
  keyTopics: [] as Array<{ topic: string; count: number; priority: string }>,
  actionItems: [] as Array<{ task: string; due: string; from: string; priority: string }>,
};

export default function EmailSummaryPage() {
  const { mutate, isPending, data } = useInboxSummary();

  // Trigger on mount — mirrors the old useEffect fetch.
  useEffect(() => {
    mutate({ period: 'today' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isPending) {
    return <PageLoader fullScreen={false} />;
  }

  // The hook returns { success, data?: { summary?: ... } }.
  const rawSummary =
    data?.success && data.data?.summary
      ? (data.data.summary as Record<string, unknown>)
      : null;

  const summary = rawSummary
    ? {
        totalEmails: (rawSummary.totalEmails as number | undefined) ?? 0,
        unread: (rawSummary.unread as number | undefined) ?? 0,
        important: (rawSummary.important as number | undefined) ?? 0,
        requiresAction: (rawSummary.requiresAction as number | undefined) ?? 0,
        categories: (
          (rawSummary.categories as Array<{ name: string; count: number }> | undefined) ?? []
        ).map((cat) => ({
          ...cat,
          color: categoryColors[cat.name] ?? 'bg-gray-500 dark:bg-border',
        })),
        topSenders:
          (rawSummary.topSenders as Array<{ name: string; email: string; count: number }> | undefined) ??
          [],
        keyTopics:
          (rawSummary.keyTopics as Array<{ topic: string; count: number; priority: string }> | undefined) ??
          [],
        actionItems:
          (rawSummary.actionItems as Array<{ task: string; due: string; from: string; priority: string }> | undefined) ??
          [],
      }
    : emptySummary;

  return <SummaryClient initialSummary={summary} />;
}
