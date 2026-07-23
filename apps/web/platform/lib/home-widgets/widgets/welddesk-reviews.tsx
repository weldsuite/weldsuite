import { z } from 'zod';
import { Star } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useHelpdeskReviews } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
import { DeskReviewsCard, type DeskReviewRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const welddeskReviewsSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WelddeskReviewsSettings = z.infer<typeof welddeskReviewsSchema>;

interface ApiReview {
  id: string;
  customerName?: string;
  customerEmail?: string;
  rating?: number;
  source?: string;
  comment?: string;
  body?: string;
  createdAt?: string;
}

function relativeWhen(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 60) return `${Math.max(1, diffMin)}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  const diffDays = Math.floor(diffMin / 1440);
  if (diffDays === 1) return 'Yest';
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapSource(s: string | undefined): string {
  if (s === 'email') return 'Email';
  if (s === 'widget' || s === 'chat') return 'Widget';
  return 'In-app';
}

function mapReview(api: ApiReview): DeskReviewRow {
  const customer = api.customerName ?? api.customerEmail ?? '—';
  return {
    customer,
    initials: customer.charAt(0).toUpperCase(),
    rating: typeof api.rating === 'number' ? Math.min(Math.max(api.rating, 0), 5) : 0,
    source: mapSource(api.source),
    comment: api.comment ?? api.body ?? '',
    when: relativeWhen(api.createdAt),
  };
}

function Render({ settings }: { settings: WelddeskReviewsSettings }) {
  const reviewsRes = useHelpdeskReviews({ pageSize: settings.maxCount });
  const apiRows = ((reviewsRes.data as { data?: ApiReview[] } | undefined)?.data ?? []) as ApiReview[];
  const rows = apiRows.map(mapReview).slice(0, settings.maxCount);
  return <DeskReviewsCard rows={rows} isLoading={reviewsRes.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WelddeskReviewsSettings; onChange: (next: WelddeskReviewsSettings) => void }) {
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

export const welddeskReviewsWidget: HomeWidgetDefinition<WelddeskReviewsSettings> = {
  id: 'welddesk-reviews',
  module: 'welddesk',
  title: 'Customer reviews',
  description: 'Recent customer reviews',
  icon: Star,
  schema: welddeskReviewsSchema,
  defaultSettings: welddeskReviewsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};
