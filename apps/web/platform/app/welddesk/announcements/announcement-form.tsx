import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import {
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_VISIBILITIES,
  type AnnouncementStatus,
  type AnnouncementType,
  type AnnouncementVisibility,
  type CreateHelpdeskAnnouncementInput,
} from '@weldsuite/core-api-client/schemas/helpdesk-announcements';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SettingRow } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { CompanyMultiPicker } from '@/app/welddesk/components/company-multi-picker';
import {
  useCreateDeskAnnouncement,
  useDeleteDeskAnnouncement,
  useUpdateDeskAnnouncement,
  type DeskAnnouncement,
} from '@/hooks/queries/use-desk-knowledge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { ANNOUNCEMENT_TYPE_TONE, fromLocalInput, toLocalInput } from './announcement-labels';

const BASE = '/welddesk/help-center/announcements';

interface FormState {
  title: string;
  content: string;
  excerpt: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  visibility: AnnouncementVisibility;
  targetGroups: string[];
  publishedAt: string;
  expiresAt: string;
  isPinned: boolean;
}

function pick<T extends string>(options: readonly T[], value: string | null | undefined, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function initialState(announcement?: DeskAnnouncement): FormState {
  return {
    title: announcement?.title ?? '',
    content: announcement?.content ?? '',
    excerpt: announcement?.excerpt ?? '',
    type: pick(ANNOUNCEMENT_TYPES, announcement?.type, 'info'),
    status: pick(ANNOUNCEMENT_STATUSES, announcement?.status, 'draft'),
    visibility: pick(ANNOUNCEMENT_VISIBILITIES, announcement?.visibility, 'public'),
    targetGroups: Array.isArray(announcement?.targetGroups) ? announcement.targetGroups : [],
    publishedAt: toLocalInput(announcement?.publishedAt),
    expiresAt: toLocalInput(announcement?.expiresAt),
    isPinned: announcement?.isPinned ?? false,
  };
}

interface AnnouncementFormProps {
  /** The announcement being edited; none to create one. */
  announcement?: DeskAnnouncement;
}

/** Create or edit one announcement: its message, how it shows, and when. */
export function AnnouncementForm({ announcement }: Readonly<AnnouncementFormProps>) {
  const { t } = useI18n();
  const a = t.helpdesk.announcementsAdmin;
  const router = useRouter();
  const canDelete = useCan('articles:delete');
  const create = useCreateDeskAnnouncement();
  const update = useUpdateDeskAnnouncement();
  const remove = useDeleteDeskAnnouncement();
  const [form, setForm] = useState<FormState>(() => initialState(announcement));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saving = create.isPending || update.isPending;
  const submitLabel = announcement ? a.save : a.create;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const validate = (): string | null => {
    if (!form.title.trim()) return a.titleRequired;
    if (!form.content.trim()) return a.contentRequired;
    const from = fromLocalInput(form.publishedAt);
    const until = fromLocalInput(form.expiresAt);
    if (from && until && Date.parse(until) <= Date.parse(from)) return a.expiresBeforePublished;
    return null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = validate();
    setError(problem);
    if (problem) return;

    const body: CreateHelpdeskAnnouncementInput = {
      title: form.title.trim(),
      content: form.content.trim(),
      excerpt: form.excerpt.trim() || null,
      type: form.type,
      status: form.status,
      visibility: form.visibility,
      targetGroups: form.visibility === 'specific_groups' ? form.targetGroups : [],
      publishedAt: fromLocalInput(form.publishedAt),
      expiresAt: fromLocalInput(form.expiresAt),
      isPinned: form.isPinned,
    };
    try {
      if (announcement) {
        await update.mutateAsync({ id: announcement.id, data: body });
        toast.success(a.saved);
      } else {
        await create.mutateAsync(body);
        toast.success(a.created);
      }
      router.push(BASE);
    } catch {
      setError(a.saveFailed);
    }
  };

  const deleteIt = async () => {
    if (!announcement) return;
    try {
      await remove.mutateAsync(announcement.id);
      toast.success(a.deleted);
      router.push(BASE);
    } catch {
      toast.error(a.deleteFailed);
    }
  };

  return (
    <DetailPage className="mx-auto max-w-3xl">
      <form onSubmit={(e) => void submit(e)} className="space-y-6" data-testid="announcement-form">
        <DetailHeader
          title={announcement ? a.editAnnouncement : a.newAnnouncement}
          onBack={() => router.push(BASE)}
          backLabel={a.back}
          badges={
            <SoftBadge tone={ANNOUNCEMENT_TYPE_TONE[form.type] ?? 'neutral'}>{a.types[form.type]}</SoftBadge>
          }
          actions={
            <>
              {announcement && canDelete && (
                <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)}>
                  <Trash className="mr-1.5 h-4 w-4" />
                  {a.delete}
                </Button>
              )}
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {saving ? a.saving : submitLabel}
              </Button>
            </>
          }
        />

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        <SectionCard title={a.sections.message} contentClassName="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="title">{a.fields.title}</Label>
            <Input id="title" value={form.title} maxLength={500} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="content">{a.fields.content}</Label>
            <Textarea id="content" rows={5} value={form.content} onChange={(e) => set('content', e.target.value)} />
            <p className="text-xs text-muted-foreground">{a.fields.contentHint}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="excerpt">{a.fields.excerpt}</Label>
            <Input id="excerpt" value={form.excerpt} onChange={(e) => set('excerpt', e.target.value)} />
            <p className="text-xs text-muted-foreground">{a.fields.excerptHint}</p>
          </div>
        </SectionCard>

        <SectionCard title={a.sections.display} contentClassName="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="type">{a.fields.type}</Label>
              <Select value={form.type} onValueChange={(value) => set('type', value as AnnouncementType)}>
                <SelectTrigger id="type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANNOUNCEMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {a.types[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">{a.fields.status}</Label>
              <Select value={form.status} onValueChange={(value) => set('status', value as AnnouncementStatus)}>
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANNOUNCEMENT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {a.statuses[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="visibility">{a.fields.visibility}</Label>
              <Select
                value={form.visibility}
                onValueChange={(value) => set('visibility', value as AnnouncementVisibility)}
              >
                <SelectTrigger id="visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANNOUNCEMENT_VISIBILITIES.map((visibility) => (
                    <SelectItem key={visibility} value={visibility}>
                      {a.visibilities[visibility]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.visibility === 'specific_groups' && (
            <div className="space-y-1.5">
              <Label>{a.fields.targetGroups}</Label>
              <CompanyMultiPicker value={form.targetGroups} onChange={(ids) => set('targetGroups', ids)} />
              {form.targetGroups.length === 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">{t.helpdesk.articleAudience.noCompaniesPicked}</p>
              )}
            </div>
          )}
          <SettingRow label={a.fields.pinned} description={a.fields.pinnedHint}>
            <Switch checked={form.isPinned} onCheckedChange={(checked) => set('isPinned', checked)} aria-label={a.fields.pinned} />
          </SettingRow>
        </SectionCard>

        <SectionCard title={a.sections.schedule} contentClassName="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="publishedAt">{a.fields.publishedAt}</Label>
            <Input
              id="publishedAt"
              type="datetime-local"
              value={form.publishedAt}
              onChange={(e) => set('publishedAt', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{a.fields.publishedAtHint}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="expiresAt">{a.fields.expiresAt}</Label>
            <Input
              id="expiresAt"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(e) => set('expiresAt', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{a.fields.expiresAtHint}</p>
          </div>
        </SectionCard>
      </form>

      {announcement && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={a.deleteTitle}
          description={a.deleteDescription.replace('{title}', announcement.title)}
          confirmLabel={a.delete}
          variant="destructive"
          loading={remove.isPending}
          onConfirm={deleteIt}
        />
      )}
    </DetailPage>
  );
}
