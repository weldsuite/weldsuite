import { useState } from 'react';
import { Clock, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { sumMinutes, useLogMergeIssueTime, useMergeIssueTime } from '@/hooks/queries/use-weldmerge-across-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatMinutes, toMinutes } from '../lib/across';
import { fill, todayIso } from '../lib/format';

/**
 * Time logged against an issue (WeldFlow time entries): the total, the latest
 * entries and a small form to log more. Logging needs `time:create`.
 */
export function IssueTimePanel({ issueId }: Readonly<{ issueId: string }>) {
  const { t } = useI18n();
  const tt = t.weldmerge.across.issue.time;
  const canLog = useCan('time:create');
  const entries = useMergeIssueTime(issueId);
  const log = useLogMergeIssueTime();

  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');

  const rows = entries.data ?? [];
  const total = sumMinutes(rows);

  const submit = async () => {
    const minutes = toMinutes(amount, unit);
    if (minutes === 0) {
      toast.error(tt.invalid);
      return;
    }
    try {
      await log.mutateAsync({ issueId, minutes, date, description: description.trim() });
      setAmount('');
      setDescription('');
      setAdding(false);
      toast.success(tt.logged);
    } catch {
      toast.error(tt.logFailed);
    }
  };

  return (
    <div className="space-y-3">
      {entries.isError && <p className="text-sm text-destructive">{tt.loadFailed}</p>}
      {!entries.isError && rows.length === 0 && <p className="text-sm text-muted-foreground">{tt.none}</p>}
      {!entries.isError && rows.length > 0 && (
        <>
          <p className="flex items-center gap-2 text-sm font-medium">
            <Clock className="size-4 text-muted-foreground" />
            {fill(tt.total, { time: formatMinutes(total) })}
          </p>
          <ul className="space-y-1 text-sm">
            {rows.slice(0, 5).map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.description || '—'}</span>
                <span className="shrink-0 tabular-nums">
                  {fill(tt.entry, { time: formatMinutes(Number(entry.duration) || 0), date: entry.date.slice(0, 10) })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {canLog && !adding && (
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
          <Plus />
          {tt.log}
        </Button>
      )}

      {canLog && adding && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-label={unit === 'hours' ? tt.hours : tt.minutes}
              className="h-8"
            />
            <Select value={unit} onValueChange={(value) => setUnit(value as 'minutes' | 'hours')}>
              <SelectTrigger size="sm" className="w-28" aria-label={tt.title}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hours">{tt.hours}</SelectItem>
                <SelectItem value="minutes">{tt.minutes}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label={tt.date} className="h-8" />
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={tt.description}
            aria-label={tt.description}
            className="h-8"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void submit()} disabled={log.isPending}>
              {log.isPending && <Loader2 className="animate-spin" />}
              {tt.submit}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
              {t.common.actions.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
