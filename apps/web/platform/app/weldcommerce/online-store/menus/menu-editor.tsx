/**
 * Edit one menu: its name and its links, each with a label and where it goes
 * (the home page, all products, the cart, the account, search, a category, a
 * product, a content page or an address), with one level of sub-links. Links
 * are reordered with move up and move down buttons; focus stays on the
 * button used and one polite announcement says where the link went.
 */

import { useEffect, useRef, useState } from 'react';
import { useFieldArray, useForm, useFormContext, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, CornerDownRight, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useSaveStoreMenu, useStorePages, type StoreMenu } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { CatalogueChoice } from '../editor/setting-field';
import {
  LINK_TYPES,
  buildMenuSchema,
  countLinks,
  emptyLink,
  needsTarget,
  toMenuFormValues,
  toMenuItems,
  type LinkType,
  type MenuFormValues,
} from '../lib/menus';

const NONE = '__none__';
const urlProps = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, inputMode: 'url' } as const;

type LinkPath = `items.${number}` | `items.${number}.children.${number}`;

interface Mover {
  announce: (message: string) => void;
  focusAfter: (key: string, fallback?: string) => void;
}

function LinkFields({ path, siteId, name }: Readonly<{ path: LinkPath; siteId: string; name: string }>) {
  const t = getTranslations('commerce').onlineStore.menus;
  const form = useFormContext<MenuFormValues>();
  const linkType = useWatch({ control: form.control, name: `${path}.linkType` }) as LinkType;
  const pages = useStorePages(siteId, linkType === 'page');

  return (
    // Each link's fields are a group named after the link, so "Label" and "Links to" say which link they belong to.
    <fieldset className="grid min-w-0 flex-1 gap-3 @xl:grid-cols-3">
      <legend className="sr-only">{name}</legend>
      <FormField
        control={form.control}
        name={`${path}.label`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.label}</FormLabel>
            <FormControl>
              <Input {...field} maxLength={200} autoComplete="off" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name={`${path}.linkType`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.linkType}</FormLabel>
            <Select
              value={field.value}
              onValueChange={(value) => {
                field.onChange(value);
                form.setValue(`${path}.target`, '', { shouldDirty: true });
              }}
            >
              <FormControl>
                <SelectTrigger onBlur={field.onBlur}>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {LINK_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t.linkTypes[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      {needsTarget(linkType) && (
        <FormField
          control={form.control}
          name={`${path}.target`}
          render={({ field }) => {
            const targetLabel = t.target[linkType as 'category' | 'product' | 'page' | 'url'];
            if (linkType === 'category' || linkType === 'product') {
              return (
                <FormItem>
                  <FormLabel>{targetLabel}</FormLabel>
                  <FormControl>
                    <CatalogueChoice
                      kind={linkType}
                      value={field.value}
                      onChange={(value) => {
                        field.onChange(value);
                        field.onBlur();
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              );
            }
            if (linkType === 'page') {
              return (
                <FormItem>
                  <FormLabel>{targetLabel}</FormLabel>
                  <Select value={field.value || NONE} onValueChange={(value) => field.onChange(value === NONE ? '' : value)}>
                    <FormControl>
                      <SelectTrigger onBlur={field.onBlur}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{getTranslations('commerce').onlineStore.fields.choose}</SelectItem>
                      {(pages.data?.data ?? []).map((page) => (
                        <SelectItem key={page.id} value={page.id}>
                          {page.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              );
            }
            return (
              <FormItem>
                <FormLabel>{targetLabel}</FormLabel>
                <FormControl>
                  <Input {...field} {...urlProps} placeholder="/products" className="font-mono" />
                </FormControl>
                <FormMessage />
              </FormItem>
            );
          }}
        />
      )}
    </fieldset>
  );
}

function MoveButtons({
  focusKey,
  name,
  index,
  count,
  onMove,
  onRemove,
}: Readonly<{ focusKey: string; name: string; index: number; count: number; onMove: (direction: -1 | 1) => void; onRemove: () => void }>) {
  const t = getTranslations('commerce').onlineStore.menus;
  return (
    <div className="flex shrink-0 gap-0.5 pt-6">
      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={fill(t.moveUp, { name })} disabled={index === 0} data-focus={`${focusKey}:up`} onClick={() => onMove(-1)}>
        <ArrowUp className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={fill(t.moveDown, { name })}
        disabled={index === count - 1}
        data-focus={`${focusKey}:down`}
        onClick={() => onMove(1)}
      >
        <ArrowDown className="size-4" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={fill(t.remove, { name })} onClick={onRemove}>
        <Trash2 className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function ChildLinks({ index, siteId, parentName, mover, full }: Readonly<{ index: number; siteId: string; parentName: string; mover: Mover; full: boolean }>) {
  const t = getTranslations('commerce').onlineStore.menus;
  const form = useFormContext<MenuFormValues>();
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: `items.${index}.children`, keyName: 'key' });
  const children = useWatch({ control: form.control, name: `items.${index}.children` });

  return (
    <div className="ml-6 space-y-3 border-l pl-4">
      {fields.length > 0 && <p className="text-xs text-muted-foreground">{fill(t.children, { name: parentName })}</p>}
      <ul className="space-y-3">
        {fields.map((field, childIndex) => {
          const name = children?.[childIndex]?.label || t.untitled;
          return (
            <li key={field.key} className="flex items-start gap-2">
              <CornerDownRight className="mt-8 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <LinkFields path={`items.${index}.children.${childIndex}`} siteId={siteId} name={name} />
              <MoveButtons
                focusKey={field.key}
                name={name}
                index={childIndex}
                count={fields.length}
                onMove={(direction) => {
                  move(childIndex, childIndex + direction);
                  mover.focusAfter(`${field.key}:${direction === -1 ? 'up' : 'down'}`, `${field.key}:${direction === -1 ? 'down' : 'up'}`);
                  mover.announce(fill(t.moved, { name, position: childIndex + direction + 1, count: fields.length }));
                }}
                onRemove={() => {
                  remove(childIndex);
                  mover.focusAfter(`add-child:${index}`);
                }}
              />
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="ghost" size="sm" disabled={full} data-focus={`add-child:${index}`} onClick={() => append(emptyLink())}>
        <Plus className="size-4" aria-hidden="true" />
        {fill(t.addChild, { name: parentName })}
      </Button>
    </div>
  );
}

export function MenuEditor({ siteId, menu }: Readonly<{ siteId: string; menu: StoreMenu }>) {
  const t = getTranslations('commerce').onlineStore.menus;
  const save = useSaveStoreMenu();
  const form = useForm<MenuFormValues>({ resolver: zodResolver(buildMenuSchema()), defaultValues: toMenuFormValues(menu) });
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: 'items', keyName: 'key' });
  const items = useWatch({ control: form.control, name: 'items' });
  const [status, setStatus] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ key: string; fallback?: string } | null>(null);
  const full = countLinks(items ?? []) >= 100;
  const itemsError = form.formState.errors.items?.root?.message ?? form.formState.errors.items?.message;

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const find = (key?: string) => (key ? listRef.current?.querySelector<HTMLButtonElement>(`[data-focus="${key}"]`) : null);
    const wanted = find(pending.key);
    (wanted && !wanted.disabled ? wanted : find(pending.fallback))?.focus();
  });

  const mover: Mover = {
    announce: (message) => {
      setStatus('');
      requestAnimationFrame(() => setStatus(message));
    },
    focusAfter: (key, fallback) => {
      pendingFocus.current = { key, fallback };
    },
  };

  const onSubmit = async (values: MenuFormValues) => {
    try {
      const res = await save.mutateAsync({ siteId, handle: menu.handle, data: { title: values.title.trim(), items: toMenuItems(values) } });
      form.reset(toMenuFormValues(res.data ?? { title: values.title, items: toMenuItems(values) }));
      toast.success(t.saved);
    } catch (err) {
      toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="@container space-y-5" aria-label={menu.title || menu.handle}>
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem className="max-w-sm">
              <FormLabel>{t.menuTitle}</FormLabel>
              <FormControl>
                <Input {...field} maxLength={200} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t.items}</legend>
          <div ref={listRef} className="space-y-4">
            {fields.length === 0 && <p className="text-sm text-muted-foreground">{t.noItems}</p>}
            <ul className="space-y-4">
              {fields.map((field, index) => {
                const name = items?.[index]?.label || t.untitled;
                return (
                  <li key={field.key} className="space-y-3 rounded-md border p-3">
                    <div className="flex items-start gap-2">
                      <LinkFields path={`items.${index}`} siteId={siteId} name={name} />
                      <MoveButtons
                        focusKey={field.key}
                        name={name}
                        index={index}
                        count={fields.length}
                        onMove={(direction) => {
                          move(index, index + direction);
                          mover.focusAfter(`${field.key}:${direction === -1 ? 'up' : 'down'}`, `${field.key}:${direction === -1 ? 'down' : 'up'}`);
                          mover.announce(fill(t.moved, { name, position: index + direction + 1, count: fields.length }));
                        }}
                        onRemove={() => {
                          remove(index);
                          mover.focusAfter('add-item');
                        }}
                      />
                    </div>
                    <ChildLinks index={index} siteId={siteId} parentName={name} mover={mover} full={full} />
                  </li>
                );
              })}
            </ul>
            <Button type="button" variant="outline" size="sm" disabled={full} data-focus="add-item" onClick={() => append({ ...emptyLink(), children: [] })}>
              <Plus className="size-4" aria-hidden="true" />
              {t.addItem}
            </Button>
          </div>
          {(full || itemsError) && <p className="text-sm text-muted-foreground">{itemsError ?? t.tooMany}</p>}
        </fieldset>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {t.save}
          </Button>
          {form.formState.isDirty && <span className="text-sm text-muted-foreground">{t.unsaved}</span>}
        </div>
        <p role="status" className="sr-only">
          {status}
        </p>
      </form>
    </Form>
  );
}
