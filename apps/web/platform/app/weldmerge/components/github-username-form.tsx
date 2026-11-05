import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateMyMergeAccounts } from '@/hooks/queries/use-weldmerge-queries';

/** GitHub logins: letters, digits and single hyphens, up to 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * One input for the member's GitHub username (`accounts/me`). Review requests
 * and authored pull requests are matched to the member by it.
 */
export function GithubUsernameForm({ current }: Readonly<{ current: string | null }>) {
  const { t } = useI18n();
  const ta = t.weldmerge.settings.accounts;
  const update = useUpdateMyMergeAccounts();
  const schema = useMemo(
    () =>
      z.object({
        github: z
          .string()
          .trim()
          .refine((value) => value === '' || GITHUB_LOGIN.test(value), { message: ta.invalid }),
      }),
    [ta.invalid],
  );
  const form = useForm<{ github: string }>({
    resolver: zodResolver(schema),
    defaultValues: { github: current ?? '' },
  });

  useEffect(() => {
    form.reset({ github: current ?? '' });
  }, [current, form]);

  const onSubmit = form.handleSubmit(async ({ github }) => {
    try {
      await update.mutateAsync({ github: github === '' ? null : github });
      toast.success(ta.saved);
    } catch {
      toast.error(ta.saveFailed);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="flex items-start gap-2" aria-label={ta.github}>
        <FormField
          control={form.control}
          name="github"
          render={({ field }) => (
            <FormItem className="min-w-0 flex-1">
              <FormControl>
                <Input {...field} placeholder={ta.githubPlaceholder} autoComplete="off" spellCheck={false} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
          {update.isPending && <Loader2 className="animate-spin" />}
          {ta.save}
        </Button>
      </form>
    </Form>
  );
}
