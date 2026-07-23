import { z } from 'zod';
import { FolderOpen } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useDriveFiles } from '@/hooks/queries/use-drive-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DriveCard, type FileRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const welddriveRecentSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddriveRecentSettings = z.infer<typeof welddriveRecentSchema>;

interface ApiFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: number;
  ownerName?: string;
  updatedBy?: { name?: string };
  modifiedBy?: { name?: string };
  updatedAt?: string;
}

function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extFromName(name: string | undefined): { stem: string; ext: string } {
  if (!name) return { stem: '—', ext: '' };
  const dot = name.lastIndexOf('.');
  if (dot < 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

function relativeWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 60) return `${Math.max(1, diffMin)}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  const diffDays = Math.floor(diffMin / 1440);
  if (diffDays === 1) return 'Yest';
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapFile(api: ApiFile): FileRow {
  const { stem, ext } = extFromName(api.name);
  return {
    name: stem,
    ext: ext.toLowerCase(),
    size: formatSize(api.size),
    author: api.modifiedBy?.name ?? api.updatedBy?.name ?? api.ownerName ?? '—',
    when: relativeWhen(api.updatedAt),
  };
}

function Render({ settings }: { settings: WelddriveRecentSettings }) {
  const res = useDriveFiles({ pageSize: settings.maxCount, sort: 'modified_desc' } as never);
  const apiRows = ((res.data as { data?: ApiFile[] } | undefined)?.data ?? []) as ApiFile[];
  const rows = apiRows.map(mapFile).slice(0, settings.maxCount);
  return <DriveCard rows={rows} isLoading={res.isLoading} title="WeldDrive — Recent" />;
}

function SettingsForm({ value, onChange }: { value: WelddriveRecentSettings; onChange: (next: WelddriveRecentSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div>
      <Label className="mb-2 block">{f.maxRows}</Label>
      <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{[5, 10, 20].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export const welddriveRecentWidget: HomeWidgetDefinition<WelddriveRecentSettings> = {
  id: 'welddrive-recent',
  module: 'welddrive',
  title: 'Recent files',
  description: 'Recently modified files',
  icon: FolderOpen,
  schema: welddriveRecentSchema,
  defaultSettings: welddriveRecentSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};
