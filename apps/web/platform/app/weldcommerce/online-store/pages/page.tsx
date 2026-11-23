/**
 * The content pages of an online store (`/weldcommerce/online-store/$siteId/pages`):
 * create one from a template, show or hide it in the shop, change its title,
 * address and search engine texts, delete it, or open its sections in the
 * editor. Reading needs `websites:read`; creating `:create`; changing
 * `:update`; deleting `:delete`.
 */

import { useMemo, useState } from 'react';
import { FileText, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useDeleteStorePage,
  useStorePages,
  useUpdateStorePage,
  type OnlineStoreSite,
  type StorePage,
} from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { useConfirmDelete } from '@/app/weldcommerce/lib/use-confirm-delete';
import { PageDialog } from '../components/page-dialog';
import { StoreSubpage, type StorePermissions } from '../components/store-subpage';

function PagesList({ site, permissions }: Readonly<{ site: OnlineStoreSite; permissions: StorePermissions }>) {
  const t = getTranslations('commerce').onlineStore.pages;
  const tc = getTranslations('commerce').common;
  const pages = useStorePages(site.id);
  const update = useUpdateStorePage();
  const remove = useDeleteStorePage();
  const [dialog, setDialog] = useState<{ page?: StorePage } | null>(null);
  const rows = useMemo(() => [...(pages.data?.data ?? [])].sort((a, b) => a.position - b.position), [pages.data]);

  const confirmDelete = useConfirmDelete<StorePage>({
    title: t.confirmDelete,
    name: (page) => page.title,
    onDelete: async (page) => {
      try {
        await remove.mutateAsync({ siteId: site.id, pageId: page.id });
        toast.success(t.deleted);
      } catch (err) {
        toast.error(errorMessage(err, tc.deleteFailed));
      }
    },
  });

  const toggleVisible = async (page: StorePage, visible: boolean) => {
    try {
      await update.mutateAsync({ siteId: site.id, pageId: page.id, data: { visible } });
    } catch (err) {
      toast.error(errorMessage(err, tc.saveFailed));
    }
  };

  const newButton = permissions.canCreate ? (
    <Button type="button" size="sm" onClick={() => setDialog({})}>
      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      {t.new}
    </Button>
  ) : undefined;

  let body;
  if (pages.isPending) body = <PageLoader fullScreen={false} />;
  else if (pages.isError) body = <ErrorState message={t.loadFailed} onRetry={() => void pages.refetch()} />;
  else if (rows.length === 0) body = <EmptyState icon={FileText} title={t.empty} description={t.emptyDescription} action={newButton} />;
  else {
    body = (
      <div className="@container rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.columns.title}</TableHead>
              <TableHead className="hidden @xl:table-cell">{t.columns.slug}</TableHead>
              <TableHead>{t.columns.visible}</TableHead>
              <TableHead>
                <span className="sr-only">{t.columns.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((page) => (
              <TableRow key={page.id} className={page.visible ? undefined : 'text-muted-foreground'}>
                <TableCell className="max-w-[18rem]">
                  <span className="block truncate font-medium">{page.title}</span>
                </TableCell>
                <TableCell className="hidden font-mono text-xs @xl:table-cell">{page.slug}</TableCell>
                <TableCell>
                  <Switch
                    checked={page.visible}
                    disabled={!permissions.canUpdate}
                    aria-label={fill(t.visibleLabel, { name: page.title })}
                    onCheckedChange={(checked) => void toggleVisible(page, checked)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/weldcommerce/online-store/${site.id}/editor?page=${encodeURIComponent(page.id)}`} aria-label={fill(t.editContentLabel, { name: page.title })}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden @2xl:inline">{t.editContent}</span>
                      </Link>
                    </Button>
                    {permissions.canUpdate && (
                      <Button type="button" variant="ghost" size="icon" aria-label={fill(t.settingsLabel, { name: page.title })} onClick={() => setDialog({ page })}>
                        <Settings2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                    {permissions.canDelete && (
                      <Button type="button" variant="ghost" size="icon" aria-label={fill(t.deleteLabel, { name: page.title })} onClick={() => confirmDelete.request(page)}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {rows.length > 0 && newButton && <div className="flex justify-end">{newButton}</div>}
      {body}
      {dialog && <PageDialog siteId={site.id} locale={site.locale} page={dialog.page} onClose={() => setDialog(null)} />}
      {confirmDelete.dialog}
    </div>
  );
}

export default function StorePagesPage() {
  const t = getTranslations('commerce').onlineStore.pages;
  return (
    <StoreSubpage title={t.title} description={t.description}>
      {(site, permissions) => <PagesList site={site} permissions={permissions} />}
    </StoreSubpage>
  );
}
