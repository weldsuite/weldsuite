/**
 * WeldSign templates: reusable requests (documents, fields and roles). "New
 * template" creates one straight away and opens it in the editor; "Use" asks
 * who fills each role and makes a draft request.
 */

import { useDeferredValue, useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { SignTemplateSummary } from '@weldsuite/app-api-client/schemas/weldsign';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateSignTemplate, useDeleteSignTemplate, useSignTemplates } from '@/hooks/queries/use-weldsign-queries';
import { canUseTemplate } from '../lib/use-template';
import { RoleChips } from './role-chips';
import { UseTemplateDialog } from './use-template-dialog';

export default function WeldSignTemplates() {
  const { t, format, language } = useI18n();
  const tt = t.weldsign.templates;
  const router = useRouter();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [deleting, setDeleting] = useState<SignTemplateSummary | null>(null);
  const [usingId, setUsingId] = useState<string | null>(null);

  const canRead = useCan('sign_templates:read');
  const canCreate = useCan('sign_templates:create');
  const canUpdate = useCan('sign_templates:update');
  const canDelete = useCan('sign_templates:delete');
  const canUse = useCan('sign_envelopes:create');

  const query = useSignTemplates(deferredSearch, canRead);
  const create = useCreateSignTemplate();
  const remove = useDeleteSignTemplate();

  useBreadcrumbs([{ label: t.weldsign.breadcrumb.home, href: '/weldsign' }, { label: tt.title }]);

  if (!canRead) return <div className="flex h-full items-center justify-center p-10 text-muted-foreground">{tt.noAccess}</div>;

  const open = (template: Pick<SignTemplateSummary, 'id'>) => router.push(`/weldsign/templates/${template.id}`);

  async function newTemplate() {
    try {
      open(await create.mutateAsync({ title: tt.untitled }));
    } catch {
      toast.error(tt.createFailed);
    }
  }

  async function confirmDelete(template: SignTemplateSummary) {
    try {
      await remove.mutateAsync(template.id);
      toast.success(tt.delete.done);
    } catch {
      toast.error(tt.delete.failed);
    } finally {
      setDeleting(null);
    }
  }

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  const columns: ColumnDef<SignTemplateSummary>[] = [
    {
      id: 'title',
      header: tt.table.title,
      width: 'flex-1',
      render: (template) => <span className="block truncate font-medium">{template.title}</span>,
    },
    {
      id: 'roles',
      header: tt.table.roles,
      width: 'hidden md:block md:w-[260px]',
      render: (template) => <RoleChips roles={template.roles} />,
    },
    {
      id: 'documents',
      header: tt.table.documents,
      width: 'hidden lg:block lg:w-[90px]',
      render: (template) => (
        <span className="text-sm tabular-nums text-muted-foreground">
          {format(template.documentCount === 1 ? t.weldsign.home.documentCount : t.weldsign.home.documentCountPlural, { count: template.documentCount })}
        </span>
      ),
    },
    {
      id: 'madeBy',
      header: tt.table.madeBy,
      width: 'hidden lg:block lg:w-[140px]',
      render: (template) => <span className="block truncate text-sm text-muted-foreground">{template.createdByName ?? ''}</span>,
    },
    {
      id: 'updated',
      header: tt.table.updated,
      width: 'hidden md:block md:w-[120px]',
      render: (template) => (
        <time dateTime={template.updatedAt} className="text-sm tabular-nums text-muted-foreground">
          {dateFormat.format(new Date(template.updatedAt))}
        </time>
      ),
    },
    {
      id: 'use',
      header: '',
      width: 'w-[90px]',
      render: (template) =>
        canUse ? (
          <Button
            variant="outline"
            size="sm"
            className="relative z-[1]"
            aria-label={format(tt.useActionLabel, { name: template.title })}
            title={canUseTemplate(template) ? undefined : tt.cannotUse}
            disabled={!canUseTemplate(template)}
            onClick={() => setUsingId(template.id)}
          >
            {tt.useAction}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PanelEntityList<SignTemplateSummary>
        items={query.templates}
        isLoading={query.isLoading}
        error={query.error}
        columns={columns}
        onRowClick={open}
        onEdit={canUpdate ? open : undefined}
        onDelete={canDelete ? setDeleting : undefined}
        searchQuery={search}
        onSearchChange={setSearch}
        searchFields={['title']}
        searchPlaceholder={tt.searchPlaceholder}
        createButton={canCreate ? { label: tt.newTemplate, onClick: () => void newTemplate() } : undefined}
        hasMore={query.hasNextPage}
        isLoadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
        emptyState={{
          icon: <LayoutTemplate className="size-8 text-muted-foreground" />,
          title: tt.emptyTitle,
          description: tt.emptyDescription,
          action: canCreate ? { label: tt.newTemplate, onClick: () => void newTemplate() } : undefined,
        }}
        noResultsState={{ title: tt.noResultsTitle, description: tt.noResultsDescription }}
      />

      <UseTemplateDialog templateId={usingId} onClose={() => setUsingId(null)} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={tt.delete.title}
        description={format(tt.delete.description, { name: deleting?.title ?? '' })}
        confirmLabel={tt.delete.confirm}
        variant="destructive"
        onConfirm={() => (deleting ? confirmDelete(deleting) : undefined)}
      />
    </>
  );
}
