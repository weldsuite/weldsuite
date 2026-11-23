/**
 * The redirects of an online store (`/weldcommerce/online-store/$siteId/redirects`):
 * old paths that send visitors on to new ones (301), for shops moving from
 * another platform. Reading needs `websites:read`, adding `:update`,
 * deleting `:delete`.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowRight, Loader2, Plus, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  onlineStoreErrorCode,
  useCreateStoreRedirect,
  useDeleteStoreRedirect,
  useStoreRedirects,
  type OnlineStoreSite,
  type StoreRedirect,
} from '@/hooks/queries/use-online-store-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { useConfirmDelete } from '@/app/weldcommerce/lib/use-confirm-delete';
import { StoreSubpage, type StorePermissions } from '../components/store-subpage';
import { isSafeUrl } from '../lib/settings-schema';

const pathProps = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, inputMode: 'url' } as const;

/** A path of the shop: starts with one `/`, no spaces. */
export function isShopPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !/\s/.test(value);
}

export function buildRedirectSchema(existing: readonly StoreRedirect[]) {
  const t = getTranslations('commerce').onlineStore.redirects;
  return z
    .object({
      fromPath: z.string().trim().max(2000).refine(isShopPath, t.fromInvalid),
      toPath: z
        .string()
        .trim()
        .max(2000)
        .refine((value) => isShopPath(value) || (value.startsWith('https://') && isSafeUrl(value)), t.toInvalid),
    })
    .superRefine((values, ctx) => {
      if (values.fromPath === values.toPath) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toPath'], message: t.same });
      if (existing.some((redirect) => redirect.fromPath === values.fromPath)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fromPath'], message: t.exists });
      }
    });
}

type RedirectValues = { fromPath: string; toPath: string };

function AddRedirectForm({ siteId, existing }: Readonly<{ siteId: string; existing: readonly StoreRedirect[] }>) {
  const t = getTranslations('commerce').onlineStore.redirects;
  const create = useCreateStoreRedirect();
  const schema = useMemo(() => buildRedirectSchema(existing), [existing]);
  const form = useForm<RedirectValues>({ resolver: zodResolver(schema), defaultValues: { fromPath: '', toPath: '' } });

  const onSubmit = async (values: RedirectValues) => {
    try {
      await create.mutateAsync({ siteId, data: { fromPath: values.fromPath.trim(), toPath: values.toPath.trim() } });
      toast.success(t.added);
      form.reset({ fromPath: '', toPath: '' });
      form.setFocus('fromPath');
    } catch (err) {
      if (onlineStoreErrorCode(err) === 'REDIRECT_EXISTS' || (typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409)) {
        form.setError('fromPath', { type: 'server', message: t.exists }, { shouldFocus: true });
      } else {
        toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
      }
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate aria-label={t.add} className="grid items-start gap-3 @2xl:grid-cols-[1fr_auto_1fr_auto]">
        <FormField
          control={form.control}
          name="fromPath"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.from}</FormLabel>
              <FormControl>
                <Input {...field} {...pathProps} placeholder="/old-page" className="font-mono" />
              </FormControl>
              <FormDescription>{t.fromHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <ArrowRight className="mt-8 hidden size-4 text-muted-foreground @2xl:block" aria-hidden="true" />
        <FormField
          control={form.control}
          name="toPath"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.to}</FormLabel>
              <FormControl>
                <Input {...field} {...pathProps} placeholder="/products" className="font-mono" />
              </FormControl>
              <FormDescription>{t.toHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="@2xl:mt-[1.375rem]" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          {t.add}
        </Button>
      </form>
    </Form>
  );
}

function RedirectsList({ site, permissions }: Readonly<{ site: OnlineStoreSite; permissions: StorePermissions }>) {
  const t = getTranslations('commerce').onlineStore.redirects;
  const redirects = useStoreRedirects(site.id);
  const remove = useDeleteStoreRedirect();
  const rows = redirects.data?.data ?? [];

  const confirmDelete = useConfirmDelete<StoreRedirect>({
    title: t.confirmDelete,
    name: (redirect) => `${redirect.fromPath} → ${redirect.toPath}`,
    onDelete: async (redirect) => {
      try {
        await remove.mutateAsync({ siteId: site.id, redirectId: redirect.id });
        toast.success(t.deleted);
      } catch (err) {
        toast.error(errorMessage(err, getTranslations('commerce').common.deleteFailed));
      }
    },
  });

  let body;
  if (redirects.isPending) body = <PageLoader fullScreen={false} />;
  else if (redirects.isError) body = <ErrorState message={t.loadFailed} onRetry={() => void redirects.refetch()} />;
  else if (rows.length === 0) body = <EmptyState icon={Undo2} title={t.empty} description={t.emptyDescription} />;
  else {
    body = (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.columns.from}</TableHead>
              <TableHead>{t.columns.to}</TableHead>
              <TableHead className="hidden @2xl:table-cell">{t.columns.created}</TableHead>
              <TableHead>
                <span className="sr-only">{t.columns.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((redirect) => (
              <TableRow key={redirect.id}>
                <TableCell className="max-w-[16rem] truncate font-mono text-xs">{redirect.fromPath}</TableCell>
                <TableCell className="max-w-[16rem] truncate font-mono text-xs">{redirect.toPath}</TableCell>
                <TableCell className="hidden whitespace-nowrap tabular-nums @2xl:table-cell">{formatPanelDate(redirect.createdAt) ?? '—'}</TableCell>
                <TableCell className="text-right">
                  {permissions.canDelete && (
                    <Button type="button" variant="ghost" size="icon" aria-label={fill(t.deleteLabel, { from: redirect.fromPath })} onClick={() => confirmDelete.request(redirect)}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="@container space-y-6">
      {permissions.canUpdate && (
        <SettingsSection title={t.add}>
          <AddRedirectForm siteId={site.id} existing={rows} />
        </SettingsSection>
      )}
      {body}
      {confirmDelete.dialog}
    </div>
  );
}

export default function StoreRedirectsPage() {
  const t = getTranslations('commerce').onlineStore.redirects;
  return (
    <StoreSubpage title={t.title} description={t.description}>
      {(site, permissions) => <RedirectsList site={site} permissions={permissions} />}
    </StoreSubpage>
  );
}
