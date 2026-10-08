import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { RunHistoryEntry } from '@/lib/api/domains/weldbooks-payment-runs';

interface HistoryCardProps {
  history: readonly RunHistoryEntry[];
  nameOf: (userId: string | null | undefined) => string;
}

/** The reason an entry carries, when it has one (a rejection, a released hold). */
export function reasonOf(entry: Pick<RunHistoryEntry, 'changes'>): string | null {
  const reason = entry.changes?.reason?.new;
  return typeof reason === 'string' && reason.trim() ? reason : null;
}

/** What happened to the run, oldest first. */
export function HistoryCard({ history, nameOf }: Readonly<HistoryCardProps>) {
  const { t } = useI18n();
  const th = t.weldbooksUs.payments.detail.history;
  const labels: Readonly<Record<string, string>> = th.actions;
  const { formatDateTime } = useWeldbooksFormat();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{th.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{th.empty}</p>
        ) : (
          <ol className="space-y-3 text-sm">
            {history.map((entry, index) => {
              const reason = reasonOf(entry);
              return (
                <li key={`${entry.at}-${entry.action}-${index}`} className="border-l-2 pl-3">
                  <p className="font-medium">{labels[entry.action] ?? entry.action.replaceAll('_', ' ')}</p>
                  <p className="text-xs text-muted-foreground">
                    {nameOf(entry.userId)} · {formatDateTime(entry.at)}
                  </p>
                  {reason ? <p className="mt-0.5 text-muted-foreground">{reason}</p> : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
