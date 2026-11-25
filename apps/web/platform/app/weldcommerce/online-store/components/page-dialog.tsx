/**
 * Create a content page from a template (blank, about us, contact, or one of
 * the legal pages EU shops are expected to have), or change a page's title,
 * address, search engine texts and visibility. The legal templates say they
 * are a structure to complete, not legal advice.
 */

import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { PAGE_TEMPLATES, type ShopLocale } from '@weldsuite/storefront-theme/catalog';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useCreateStorePage, useUpdateStorePage, type StorePage } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { errorMessage } from '@/app/weldcommerce/lib/text';
import { pickLabel } from '../lib/labels';
import {
  buildNewPageSchema,
  buildPageSettingsSchema,
  findPageTemplate,
  newPageValues,
  pageSettingsValues,
  toCreatePageInput,
  toUpdatePageInput,
  type NewPageValues,
  type PageSettingsValues,
} from '../lib/pages';

const slugProps = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

/** A 409 from a page write: its slug is already used by another page of the store. */
function isSlugTaken(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409;
}

function NewPageForm({ siteId, locale, onDone }: Readonly<{ siteId: string; locale: ShopLocale; onDone: () => void }>) {
  const t = getTranslations('commerce').onlineStore.pages;
  const common = getTranslations('common');
  const create = useCreateStorePage();
  const templateId = useId();
  const form = useForm<NewPageValues>({ resolver: zodResolver(buildNewPageSchema()), defaultValues: newPageValues('blank', locale) });
  const template = findPageTemplate(form.watch('template'));

  const chooseTemplate = (id: string) => {
    const next = newPageValues(id, locale);
    form.setValue('template', id);
    // The title and address follow the template until they are typed in.
    if (!form.getFieldState('title').isDirty) form.setValue('title', next.title);
    if (!form.getFieldState('slug').isDirty) form.setValue('slug', next.slug);
  };

  const onSubmit = async (values: NewPageValues) => {
    try {
      await create.mutateAsync({ siteId, data: toCreatePageInput(values) });
      toast.success(t.created);
      onDone();
    } catch (err) {
      if (isSlugTaken(err)) form.setError('slug', { type: 'server', message: t.form.slugTaken }, { shouldFocus: true });
      else toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
        <FormField
          control={form.control}
          name="template"
          render={({ field }) => (
            <FormItem>
              <FormLabel id={templateId}>{t.form.template}</FormLabel>
              <FormControl>
                <RadioGroup value={field.value} onValueChange={chooseTemplate} aria-labelledby={templateId} className="grid-cols-1 gap-2 sm:grid-cols-2">
                  {PAGE_TEMPLATES.map((option) => (
                    <div key={option.id} className="flex items-center gap-2">
                      <RadioGroupItem value={option.id} id={`${templateId}-${option.id}`} />
                      <label htmlFor={`${templateId}-${option.id}`} className="text-sm">
                        {pickLabel(option.name)}
                      </label>
                    </div>
                  ))}
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {template.legal && (
          <InfoBanner variant="warning" data-testid="legal-note">
            {t.legalNote}
          </InfoBanner>
        )}
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.form.title}</FormLabel>
              <FormControl>
                <Input {...field} required maxLength={200} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.form.slug}</FormLabel>
              <FormControl>
                <Input {...field} {...slugProps} maxLength={100} className="font-mono" />
              </FormControl>
              <FormDescription>{t.form.slugHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            {common.actions.cancel}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {common.actions.create}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

function PageSettingsForm({ siteId, page, onDone }: Readonly<{ siteId: string; page: StorePage; onDone: () => void }>) {
  const t = getTranslations('commerce').onlineStore.pages;
  const common = getTranslations('common');
  const update = useUpdateStorePage();
  const form = useForm<PageSettingsValues>({ resolver: zodResolver(buildPageSettingsSchema()), defaultValues: pageSettingsValues(page) });

  const onSubmit = async (values: PageSettingsValues) => {
    try {
      await update.mutateAsync({ siteId, pageId: page.id, data: toUpdatePageInput(values) });
      toast.success(t.saved);
      onDone();
    } catch (err) {
      if (isSlugTaken(err)) form.setError('slug', { type: 'server', message: t.form.slugTaken }, { shouldFocus: true });
      else toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.form.title}</FormLabel>
              <FormControl>
                <Input {...field} required maxLength={200} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.form.slug}</FormLabel>
              <FormControl>
                <Input {...field} {...slugProps} maxLength={100} className="font-mono" />
              </FormControl>
              <FormDescription>{t.form.slugHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="seoTitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.form.seoTitle}</FormLabel>
              <FormControl>
                <Input {...field} maxLength={200} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="seoDescription"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.form.seoDescription}</FormLabel>
              <FormControl>
                <Textarea {...field} rows={3} maxLength={500} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="visible"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-2">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
              </FormControl>
              <div className="grid gap-1">
                <FormLabel className="font-normal">{t.form.visible}</FormLabel>
                <FormDescription>{t.form.visibleHint}</FormDescription>
              </div>
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            {common.actions.cancel}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {common.actions.save}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

export function PageDialog({
  siteId,
  locale,
  page,
  onClose,
}: Readonly<{ siteId: string; locale: ShopLocale; page?: StorePage; onClose: () => void }>) {
  const t = getTranslations('commerce').onlineStore.pages;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{page ? t.editTitle : t.newTitle}</DialogTitle>
        </DialogHeader>
        {page ? <PageSettingsForm siteId={siteId} page={page} onDone={onClose} /> : <NewPageForm siteId={siteId} locale={locale} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
