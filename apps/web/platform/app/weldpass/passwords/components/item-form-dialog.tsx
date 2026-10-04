/** Create and edit a password-manager item. Saving always sends the whole item. */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Loader2, Wand2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type {
  WeldPassItemType,
  WeldPassRevealedItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import {
  useCreateWeldPassItem,
  useUpdateWeldPassItem,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { cn } from '@/lib/utils';
import { ErrorBanner, errorMessage } from '../../components/shared';
import {
  createItemFormSchema,
  emptyItemForm,
  itemToFormValues,
  toItemInput,
  type ItemFormValues,
} from '../lib/items';
import { usePasswordsT } from '../lib/use-passwords-t';
import { ItemTypeIcon } from './item-type-icon';
import { PasswordGenerator, StrengthMeter } from './password-generator';

const TYPES: WeldPassItemType[] = ['login', 'note', 'card'];

export function ItemFormDialog({
  vaults,
  vaultLabel,
  defaultVaultId,
  item,
  onClose,
  onSaved,
}: Readonly<{
  /** Vaults the caller can write to. */
  vaults: WeldPassVault[];
  vaultLabel: (vault: WeldPassVault) => string;
  defaultVaultId: string;
  /** Present when editing: the decrypted item, to prefill the form. */
  item?: WeldPassRevealedItem;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const tp = usePasswordsT();
  const createItem = useCreateWeldPassItem();
  const updateItem = useUpdateWeldPassItem();

  const [failure, setFailure] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [generating, setGenerating] = useState(false);

  const schema = useMemo(
    () => createItemFormSchema({ titleRequired: tp('form.titleRequired') }),
    // `tp` is rebuilt on every render and only closes over the locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const form = useForm<ItemFormValues>({
    resolver: zodResolver(schema),
    defaultValues: item
      ? itemToFormValues(item, item.fields)
      : emptyItemForm('login', defaultVaultId),
  });

  const type = form.watch('type');
  const password = form.watch('password');
  const pending = createItem.isPending || updateItem.isPending;
  const editing = Boolean(item);
  const currentVault = vaults.find((vault) => vault.id === form.watch('vaultId'));

  async function onSubmit(values: ItemFormValues) {
    setFailure(null);
    try {
      const input = toItemInput(values);
      if (item) {
        await updateItem.mutateAsync({ vaultId: item.vaultId, itemId: item.id, item: input });
      } else {
        await createItem.mutateAsync({ vaultId: values.vaultId, item: input });
      }
      onSaved();
    } catch (err) {
      setFailure(errorMessage(err, tp('form.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? tp('form.editTitle', { title: item?.title ?? '' }) : tp('form.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {editing ? tp('form.editDescription') : tp('form.addDescription')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            {editing ? (
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="secondary" className="gap-1">
                  <ItemTypeIcon type={type} />
                  {tp(`types.${type}`)}
                </Badge>
                <span className="text-xs text-muted-foreground">{tp('form.typeLocked')}</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{tp('form.type')}</p>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={tp('form.type')}>
                  {TYPES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={type === option}
                      onClick={() => form.setValue('type', option)}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm transition-colors',
                        type === option
                          ? 'border-primary bg-primary/5 font-medium'
                          : 'text-muted-foreground hover:bg-muted/50',
                      )}
                    >
                      <ItemTypeIcon type={option} />
                      {tp(`types.${option}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!editing && (
              <FormField
                control={form.control}
                name="vaultId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tp('form.vault')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {vaults.map((vault) => (
                          <SelectItem key={vault.id} value={vault.id}>
                            {vaultLabel(vault)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {currentVault?.kind === 'shared' && (
                      <FormDescription>{tp('form.sharedVaultHint')}</FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tp('fields.title')}</FormLabel>
                  <FormControl>
                    <Input autoFocus autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {type === 'login' && (
              <>
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tp('fields.website')}</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="url"
                          autoComplete="off"
                          placeholder="https://example.com"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tp('fields.username')}</FormLabel>
                      <FormControl>
                        <Input autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tp('fields.password')}</FormLabel>
                      <div className="flex gap-2">
                        <FormControl>
                          <Input
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => setShowPassword((shown) => !shown)}
                          aria-label={showPassword ? tp('detail.hide') : tp('detail.reveal')}
                          title={showPassword ? tp('detail.hide') : tp('detail.reveal')}
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setGenerating((open) => !open)}
                          aria-expanded={generating}
                        >
                          <Wand2 className="mr-1.5 h-4 w-4" />
                          {tp('generator.open')}
                        </Button>
                      </div>
                      <StrengthMeter password={password} />
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {generating && (
                  <PasswordGenerator
                    onCancel={() => setGenerating(false)}
                    onUse={(generated) => {
                      form.setValue('password', generated, { shouldDirty: true });
                      setShowPassword(true);
                      setGenerating(false);
                    }}
                  />
                )}

                <FormField
                  control={form.control}
                  name="totp"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tp('fields.totp')}</FormLabel>
                      <FormControl>
                        <Input
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                          placeholder="JBSWY3DPEHPK3PXP · otpauth://totp/…"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>{tp('form.totpHint')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {type === 'note' && (
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tp('fields.content')}</FormLabel>
                    <FormControl>
                      <Textarea rows={8} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {type === 'card' && (
              <>
                <FormField
                  control={form.control}
                  name="cardholder"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tp('fields.cardholder')}</FormLabel>
                      <FormControl>
                        <Input autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tp('fields.number')}</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="numeric"
                          autoComplete="off"
                          className="font-mono"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="expiry"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{tp('fields.expiry')}</FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="off"
                            placeholder="MM/YY"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="cvc"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{tp('fields.cvc')}</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="numeric"
                            autoComplete="off"
                            className="font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </>
            )}

            {type !== 'note' && (
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tp('fields.notes')}</FormLabel>
                    <FormControl>
                      <Textarea rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                {tp('common.cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {tp('common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
