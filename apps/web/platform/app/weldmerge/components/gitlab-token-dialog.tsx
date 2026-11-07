import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import type { MergeGitlabTokenInput } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { useI18n } from '@/lib/i18n/provider';
import { trimTrailingSlashes } from '../lib/url';

type Values = { host: string; token: string };

/**
 * Host + access token for a self-managed GitLab: the workspace connection
 * (`mode: 'connection'`) or the member's own account (`mode: 'account'`).
 * The server validates the pair against the GitLab API; a refusal stays in the
 * dialog so the member can correct it.
 */
export function GitlabTokenDialog({
  open,
  onOpenChange,
  mode,
  defaultHost,
  onSubmit,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'connection' | 'account';
  defaultHost?: string | null;
  onSubmit: (input: MergeGitlabTokenInput) => Promise<unknown>;
}>) {
  const { t } = useI18n();
  const tg = t.weldmerge.sync.gitlabToken;
  const schema = useMemo(
    () =>
      z.object({
        host: z
          .string()
          .trim()
          .refine((value) => /^https?:\/\/[^\s/]+/i.test(value), { message: tg.hostInvalid }),
        token: z.string().trim().min(1, tg.tokenRequired),
      }),
    [tg.hostInvalid, tg.tokenRequired],
  );
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { host: defaultHost ?? '', token: '' } });

  useEffect(() => {
    if (open) form.reset({ host: defaultHost ?? '', token: '' });
  }, [open, defaultHost, form]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await onSubmit({ host: trimTrailingSlashes(values.host), token: values.token });
      toast.success(mode === 'connection' ? tg.connectionSaved : tg.accountSaved);
      onOpenChange(false);
    } catch {
      form.setError('token', { message: tg.failed });
    }
  });

  const pending = form.formState.isSubmitting;
  const submitLabel = mode === 'connection' ? tg.submit : tg.submitAccount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'connection' ? tg.connectionTitle : tg.accountTitle}</DialogTitle>
          <DialogDescription>{mode === 'connection' ? tg.connectionDescription : tg.accountDescription}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <FormField
              control={form.control}
              name="host"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tg.host}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tg.hostPlaceholder} autoComplete="off" spellCheck={false} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tg.token}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="off" spellCheck={false} />
                  </FormControl>
                  <FormDescription>{tg.tokenHint}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {pending ? tg.submitting : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
