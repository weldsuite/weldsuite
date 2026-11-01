import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MoreVertical, X } from 'lucide-react';
import type { DocVersion } from '@weldsuite/app-api-client/schemas/docs';
import { DocModel, isWellFormedSnapshot } from '@weldsuite/docs-engine';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { downloadDocument } from '../editor/download';
import type { Person } from '../editor/comments-panel';
import { imageFetcher } from '../files';
import { docsQueryKey } from '../store/use-doc-store';

const PAGE_SIZE = 50;

/**
 * Named versions of a document beside its pages: name the current version,
 * rename one, download one as .docx, or restore one (the room keeps the
 * current document as an automatic version first, so a restore can be undone
 * by restoring that).
 */
export function VersionsPanel({ docId, name, canEdit, people, onClose }: { docId: string; name: string; canEdit: boolean; people: Person[]; onClose: () => void }) {
  const { t, language } = useI18n();
  const tv = t.welddocs.versions;
  const docs = useAppApi().docs;
  const queryClient = useQueryClient();
  const key = [...docsQueryKey, 'versions', docId] as const;
  // A page at a time: every restore adds an automatic version, so a long history is normal.
  const pages = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => docs.versions(docId, { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
  });
  const versions = pages.data?.pages.flatMap((page) => page.data);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const [naming, setNaming] = useState<{ version: DocVersion | null; value: string } | null>(null);
  const [restoring, setRestoring] = useState<DocVersion | null>(null);
  const { getToken } = useAuth();

  const save = useMutation({
    mutationFn: async ({ version, value }: { version: DocVersion | null; value: string }) =>
      version ? docs.renameVersion(docId, version.id, { name: value }) : docs.createVersion(docId, { name: value }),
    onSuccess: (_, { version }) => {
      setNaming(null);
      if (!version) toast.success(tv.created);
      void refresh();
    },
    onError: () => toast.error(tv.failed),
  });
  const restore = useMutation({
    mutationFn: (version: DocVersion) => docs.restoreVersion(docId, version.id),
    onSuccess: () => {
      setRestoring(null);
      void refresh();
    },
    onError: () => toast.error(tv.failed),
  });

  const download = async (version: DocVersion) => {
    try {
      const { data } = await docs.versionSnapshot(docId, version.id);
      if (!isWellFormedSnapshot(data.snapshot)) throw new Error('Not a document snapshot');
      const doc = DocModel.fromSnapshot(data.snapshot);
      await downloadDocument(doc, `${name} - ${label(version)}`, 'docx', { images: imageFetcher(() => getToken()), locale: language });
    } catch {
      toast.error(tv.failed);
    }
  };

  const label = (v: DocVersion) => v.name ?? tv.automatic;
  const author = (v: DocVersion) => people.find((p) => p.id === v.createdById)?.name;
  const when = (v: DocVersion) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v.createdAt));
  const submit = () => {
    const value = naming?.value.trim();
    if (naming && value) save.mutate({ version: naming.version, value });
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background" aria-label={tv.title}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="font-medium">{tv.title}</span>
        <button type="button" aria-label={tv.cancel} className="ml-auto rounded p-1 hover:bg-accent" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-sm">
        {canEdit && !naming && (
          <Button size="sm" variant="outline" onClick={() => setNaming({ version: null, value: '' })}>
            {tv.nameCurrent}
          </Button>
        )}
        {naming && (
          <form
            className="flex flex-col gap-2 rounded-lg border bg-card p-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              autoFocus
              value={naming.value}
              maxLength={255}
              placeholder={tv.namePlaceholder}
              onChange={(e) => setNaming({ ...naming, value: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-8 rounded border bg-background px-2"
            />
            <div className="flex justify-end gap-1">
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setNaming(null)}>
                {tv.cancel}
              </Button>
              <Button type="submit" size="sm" className="h-7" disabled={!naming.value.trim() || save.isPending}>
                {tv.save}
              </Button>
            </div>
          </form>
        )}
        {versions?.length === 0 && <p className="px-1 py-6 text-center text-muted-foreground">{tv.empty}</p>}
        {versions?.map((v) => (
          <div key={v.id} className="flex items-start gap-2 rounded-lg border bg-card p-3">
            <div className="min-w-0 flex-1">
              <div className={`truncate font-medium ${v.name ? '' : 'italic text-muted-foreground'}`} title={v.name ? undefined : tv.automaticHint}>
                {label(v)}
              </div>
              <div className="text-xs text-muted-foreground">
                {when(v)}
                {author(v) ? ` · ${tv.by.replace('{name}', author(v)!)}` : ''}
              </div>
            </div>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={label(v)} className="rounded p-1 hover:bg-accent">
                  <MoreVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && <DropdownMenuItem onSelect={() => setRestoring(v)}>{tv.restore}</DropdownMenuItem>}
                {canEdit && <DropdownMenuItem onSelect={() => setNaming({ version: v, value: v.name ?? '' })}>{tv.rename}</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => void download(v)}>{tv.download}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        {pages.hasNextPage && (
          <Button size="sm" variant="ghost" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            {tv.showMore}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(o) => !o && setRestoring(null)}
        title={restoring ? tv.restoreTitle.replace('{name}', label(restoring)) : ''}
        description={tv.restoreDescription}
        confirmLabel={tv.restore}
        loading={restore.isPending}
        onConfirm={() => {
          if (restoring) restore.mutate(restoring);
        }}
      />
    </aside>
  );
}
