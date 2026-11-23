/**
 * The menus of an online store (`/weldcommerce/online-store/$siteId/menus`):
 * the main and footer menus every store has, and menus of its own (a
 * sidebar, say) that a section picks by handle. Reading needs
 * `websites:read`; creating and editing `:update`; deleting `:delete`.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useDeleteStoreMenu, useSaveStoreMenu, useStoreMenus, type OnlineStoreSite, type StoreMenu } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { StoreSubpage, type StorePermissions } from '../components/store-subpage';
import { BUILT_IN_MENUS, buildNewMenuSchema } from '../lib/menus';
import { MenuEditor } from './menu-editor';

function NewMenuDialog({
  siteId,
  existing,
  onClose,
  onCreated,
}: Readonly<{ siteId: string; existing: string[]; onClose: () => void; onCreated: (handle: string) => void }>) {
  const t = getTranslations('commerce').onlineStore.menus;
  const common = getTranslations('common');
  const save = useSaveStoreMenu();
  const schema = useMemo(() => buildNewMenuSchema(existing), [existing]);
  const form = useForm<{ handle: string; title: string }>({ resolver: zodResolver(schema), defaultValues: { handle: '', title: '' } });

  const onSubmit = async (values: { handle: string; title: string }) => {
    try {
      await save.mutateAsync({ siteId, handle: values.handle.trim(), data: { title: values.title.trim(), items: [] } });
      onCreated(values.handle.trim());
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t.newTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.menuTitle}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={200} autoComplete="off" autoFocus />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="handle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.handle}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={40} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="font-mono" />
                  </FormControl>
                  <FormDescription>{t.handleHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {t.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function MenusContent({ site, permissions }: Readonly<{ site: OnlineStoreSite; permissions: StorePermissions }>) {
  const t = getTranslations('commerce').onlineStore.menus;
  const common = getTranslations('common');
  const menus = useStoreMenus(site.id);
  const remove = useDeleteStoreMenu();
  const [selected, setSelected] = useState<string>('main');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<StoreMenu | null>(null);
  const rows = menus.data?.data ?? [];
  const menu = rows.find((candidate) => candidate.handle === selected) ?? rows[0];

  if (menus.isPending) return <PageLoader fullScreen={false} />;
  if (menus.isError) return <ErrorState message={t.loadFailed} onRetry={() => void menus.refetch()} />;

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync({ siteId: site.id, handle: deleting.handle });
      toast.success(t.deleted);
      setSelected('main');
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.deleteFailed));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <nav aria-label={t.list} className="space-y-2">
        <ul className="space-y-1">
          {rows.map((candidate) => (
            <li key={candidate.handle}>
              <button
                type="button"
                aria-current={candidate.handle === menu?.handle ? 'true' : undefined}
                onClick={() => setSelected(candidate.handle)}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                  candidate.handle === menu?.handle && 'bg-accent font-medium',
                )}
              >
                <span className="block truncate">{candidate.title || candidate.handle}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{candidate.handle}</span>
              </button>
            </li>
          ))}
        </ul>
        {permissions.canUpdate && (
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden="true" />
            {t.new}
          </Button>
        )}
      </nav>
      <div className="min-w-0 space-y-4">
        {menu && (
          <>
            {permissions.canUpdate ? (
              // A fresh form per menu, and after each save of it.
              <MenuEditor key={`${menu.handle}:${menu.updatedAt ?? ''}`} siteId={site.id} menu={menu} />
            ) : (
              <p className="text-sm text-muted-foreground">{getTranslations('commerce').onlineStore.editor.readOnly}</p>
            )}
            {permissions.canDelete &&
              (BUILT_IN_MENUS.includes(menu.handle) ? (
                <p className="text-xs text-muted-foreground">{t.builtIn}</p>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(menu)}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  {t.delete}
                </Button>
              ))}
          </>
        )}
      </div>
      {creating && (
        <NewMenuDialog
          siteId={site.id}
          existing={rows.map((candidate) => candidate.handle)}
          onClose={() => setCreating(false)}
          onCreated={(handle) => {
            setSelected(handle);
            toast.success(t.saved);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t.confirmDelete}
        description={deleting ? fill(getTranslations('commerce').common.deleteDescription, { name: deleting.title || deleting.handle }) : ''}
        variant="destructive"
        confirmLabel={common.actions.delete}
        cancelLabel={common.actions.cancel}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default function StoreMenusPage() {
  const t = getTranslations('commerce').onlineStore.menus;
  return (
    <StoreSubpage title={t.title} description={t.description}>
      {(site, permissions) => <MenusContent site={site} permissions={permissions} />}
    </StoreSubpage>
  );
}
