/**
 * WeldSign home: signature requests by folder. "New request" creates a draft
 * straight away and opens it in the editor, so nothing typed is ever lost.
 */

import { useDeferredValue, useState } from 'react';
import { Signature } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import {
  SIGN_ENVELOPE_FOLDERS,
  type SignEnvelopeFolder,
  type SignEnvelopeSummary,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useCreateSignEnvelope, useDeleteSignEnvelope, useSignEnvelopes } from '@/hooks/queries/use-weldsign-queries';
import { EnvelopeStatusBadge } from './components/status-badge';

type HomeStrings = ReturnType<typeof useI18n>['t']['weldsign']['home'];

/** What an empty list says: it depends on the folder, and on whether a search is running. */
function emptyCopy(folder: SignEnvelopeFolder, searching: boolean, th: HomeStrings) {
  if (searching) return { title: th.noResultsTitle, description: th.noResultsDescription, canCreate: false };
  if (folder === 'action_required') {
    return { title: th.actionRequiredEmptyTitle, description: th.actionRequiredEmptyDescription, canCreate: false };
  }
  if (folder === 'all') return { title: th.emptyTitle, description: th.emptyDescription, canCreate: true };
  return { title: th.noResultsTitle, description: th.noResultsDescription, canCreate: false };
}

export default function WeldSignHome() {
  const { t, format, language } = useI18n();
  const th = t.weldsign.home;
  const router = useRouter();
  const [folder, setFolder] = useState<SignEnvelopeFolder>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [deleting, setDeleting] = useState<SignEnvelopeSummary | null>(null);

  const query = useSignEnvelopes(folder, deferredSearch);
  const create = useCreateSignEnvelope();
  const remove = useDeleteSignEnvelope();
  const canCreate = useCan('sign_envelopes:create');
  const canDelete = useCan('sign_envelopes:delete');

  const open = (envelope: Pick<SignEnvelopeSummary, 'id'>) => router.push(`/weldsign/${envelope.id}`);

  async function newRequest() {
    try {
      open(await create.mutateAsync({ title: th.untitled }));
    } catch {
      toast.error(th.createFailed);
    }
  }

  async function confirmDelete(envelope: SignEnvelopeSummary) {
    try {
      await remove.mutateAsync(envelope.id);
      toast.success(th.delete.done);
    } catch {
      toast.error(th.delete.failed);
    } finally {
      setDeleting(null);
    }
  }

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  const columns: ColumnDef<SignEnvelopeSummary>[] = [
    {
      id: 'title',
      header: th.table.title,
      width: 'flex-1',
      render: (envelope) => <span className="block truncate font-medium">{envelope.title}</span>,
    },
    {
      id: 'status',
      header: th.table.status,
      width: 'w-[120px]',
      render: (envelope) => <EnvelopeStatusBadge status={envelope.status} />,
    },
    {
      id: 'recipients',
      header: th.table.recipients,
      width: 'hidden md:block md:w-[240px]',
      render: (envelope) => {
        const total = envelope.recipients.signers + envelope.recipients.cc;
        if (total === 0) return <span className="text-sm text-muted-foreground">{th.noRecipients}</span>;
        const extra = total - envelope.recipientPreview.length;
        return (
          <span className="block truncate text-sm">
            {envelope.recipientPreview.join(', ')}
            {extra > 0 && <span className="text-muted-foreground"> {format(th.recipientsMore, { count: extra })}</span>}
          </span>
        );
      },
    },
    {
      id: 'documents',
      header: th.table.documents,
      width: 'hidden lg:block lg:w-[90px]',
      render: (envelope) => (
        <span className="text-sm tabular-nums text-muted-foreground">
          {format(envelope.documentCount === 1 ? th.documentCount : th.documentCountPlural, { count: envelope.documentCount })}
        </span>
      ),
    },
    {
      id: 'updated',
      header: th.table.updated,
      width: 'hidden md:block md:w-[120px]',
      render: (envelope) => (
        <time dateTime={envelope.updatedAt} className="text-sm tabular-nums text-muted-foreground">
          {dateFormat.format(new Date(envelope.updatedAt))}
        </time>
      ),
    },
  ];

  const empty = emptyCopy(folder, deferredSearch !== '', th);

  return (
    <>
      <PanelEntityList<SignEnvelopeSummary>
        items={query.envelopes}
        isLoading={query.isLoading}
        error={query.error}
        columns={columns}
        onRowClick={open}
        // Only drafts can be deleted; a sent request is voided from its own page.
        onDelete={canDelete ? (envelope) => (envelope.status === 'draft' ? setDeleting(envelope) : undefined) : undefined}
        searchQuery={search}
        onSearchChange={setSearch}
        searchFields={['title']}
        searchPlaceholder={th.searchPlaceholder}
        leftActionButtons={
          <div role="tablist" aria-label={th.title} className="flex flex-wrap items-center gap-1">
            {SIGN_ENVELOPE_FOLDERS.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={folder === value}
                onClick={() => setFolder(value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-sm transition-colors',
                  folder === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {th.folders[value]}
              </button>
            ))}
          </div>
        }
        createButton={canCreate ? { label: th.newRequest, onClick: () => void newRequest() } : undefined}
        hasMore={query.hasNextPage}
        isLoadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        emptyState={{
          icon: <Signature className="size-8 text-muted-foreground" />,
          title: empty.title,
          description: empty.description,
          action: canCreate && empty.canCreate ? { label: th.newRequest, onClick: () => void newRequest() } : undefined,
        }}
        noResultsState={{ title: th.noResultsTitle, description: th.noResultsDescription }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={th.delete.title}
        description={format(th.delete.description, { name: deleting?.title ?? '' })}
        confirmLabel={th.delete.confirm}
        variant="destructive"
        onConfirm={() => (deleting ? confirmDelete(deleting) : undefined)}
      />
    </>
  );
}
