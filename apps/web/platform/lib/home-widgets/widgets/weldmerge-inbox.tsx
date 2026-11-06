import { z } from 'zod';
import { GitPullRequest } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { MergeInboxItem } from '@weldsuite/app-api-client/schemas/weldmerge';
import { MergeInboxCard, type MergeInboxRow } from '@/components/home/app-cards';
import { useMergeInbox } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import type { HomeWidgetDefinition } from '../types';

const weldmergeInboxSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldmergeInboxSettings = z.infer<typeof weldmergeInboxSchema>;

/** The row a widget shows for an inbox item: the pull request or issue it points at. Items that are neither are left out. */
export function mapInboxItem(item: MergeInboxItem, when: string): MergeInboxRow | null {
  if (item.pullRequest) {
    return {
      id: item.id,
      kind: item.kind,
      title: item.pullRequest.title,
      reference: `${item.pullRequest.repositoryFullName} #${item.pullRequest.number}`,
      unread: !item.read,
      when,
    };
  }
  if (item.issue) {
    return { id: item.id, kind: item.kind, title: item.issue.title, reference: item.issue.key, unread: !item.read, when };
  }
  return null;
}

/** Where a row opens: its pull request or issue. */
export function inboxItemHref(item: MergeInboxItem): string {
  if (item.pullRequest) return `/weldmerge/pull-requests/${item.pullRequest.id}`;
  if (item.issue) return `/weldmerge/issues/${item.issue.key}`;
  return '/weldmerge';
}

/** `5m ago`-style age in the member's language: minutes under an hour, hours under a day, then days. */
export function compactAge(minutes: number, formatter: Intl.RelativeTimeFormat): string {
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  if (minutes < 60 * 24) return formatter.format(-Math.round(minutes / 60), 'hour');
  return formatter.format(-Math.round(minutes / (60 * 24)), 'day');
}

function Render({ settings }: Readonly<{ settings: WeldmergeInboxSettings }>) {
  const { t, language } = useI18n();
  const router = useRouter();
  const inbox = useMergeInbox();
  const kinds = t.weldmerge.inbox.kinds as Record<string, string>;
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'narrow' });

  const items = (inbox.data ?? []).slice(0, settings.maxCount);
  const rows = items.flatMap((item) => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(item.at)) / 60_000));
    const row = mapInboxItem(item, compactAge(minutes, formatter));
    return row ? [row] : [];
  });
  const hrefById = new Map(items.map((item) => [item.id, inboxItemHref(item)]));

  return (
    <MergeInboxCard
      rows={rows}
      isLoading={inbox.isLoading}
      isError={inbox.isError}
      kindLabel={(kind) => kinds[kind] ?? kind}
      onRowClick={(row) => router.push(hrefById.get(row.id) ?? '/weldmerge')}
    />
  );
}

function SettingsForm({
  value,
  onChange,
}: Readonly<{ value: WeldmergeInboxSettings; onChange: (next: WeldmergeInboxSettings) => void }>) {
  const { t } = useI18n();
  return (
    <div>
      <Label className="mb-2 block">{t.weldmerge.across.widget.maxRows}</Label>
      <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[5, 10, 20].map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export const weldmergeInboxWidget: HomeWidgetDefinition<WeldmergeInboxSettings> = {
  id: 'weldmerge-inbox',
  module: 'weldmerge',
  title: 'WeldMerge inbox',
  description: 'Pull requests and issues that need you',
  icon: GitPullRequest,
  schema: weldmergeInboxSchema,
  defaultSettings: weldmergeInboxSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};
