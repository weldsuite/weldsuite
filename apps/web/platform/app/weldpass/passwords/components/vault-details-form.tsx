/** Name + description, shared by "New vault" and the vault settings. */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { usePasswordsT } from '../lib/use-passwords-t';

export interface VaultDetailsValues {
  name: string;
  description: string;
}

export function VaultDetailsForm({
  defaultValues,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: Readonly<{
  defaultValues: VaultDetailsValues;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: VaultDetailsValues) => void | Promise<void>;
  /** Shown as a Cancel button when given (the create dialog). */
  onCancel?: () => void;
}>) {
  const tp = usePasswordsT();

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, tp('vaultForm.nameRequired')).max(100),
        description: z.string().trim().max(2000),
      }),
    // `tp` is rebuilt on every render and only closes over the locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const form = useForm<VaultDetailsValues>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tp('vaultForm.name')}</FormLabel>
              <FormControl>
                <Input autoComplete="off" placeholder={tp('vaultForm.namePlaceholder')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tp('vaultForm.description')}</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder={tp('vaultForm.descriptionPlaceholder')}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
              {tp('common.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}
