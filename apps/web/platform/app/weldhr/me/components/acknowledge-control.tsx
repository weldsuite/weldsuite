/** "Acknowledge" button that opens an inline form for an optional comment. */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@weldsuite/ui/components/form';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import { ErrorBanner, errorMessage } from '../../components/shared';

function buildSchema(maxMessage: string) {
  return z.object({ comment: z.string().max(5000, maxMessage) });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

export function AcknowledgeControl({
  onAcknowledge,
}: Readonly<{
  /** Resolves once the server accepted it; the caller's refetch then removes this control. */
  onAcknowledge: (comment: string | null) => Promise<void>;
}>) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const schema = useMemo(() => buildSchema(t('weldhr.me.reviews.commentTooLong')), [t]);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { comment: '' } });
  const { isSubmitting } = form.formState;

  async function onSubmit(values: FormValues) {
    setFailure(null);
    try {
      await onAcknowledge(values.comment.trim() || null);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.reviews.acknowledgeFailed')));
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('weldhr.me.reviews.acknowledge')}
      </Button>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
        <FormField
          control={form.control}
          name="comment"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Textarea rows={2} placeholder={t('weldhr.me.reviews.commentPlaceholder')} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.me.reviews.acknowledge')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isSubmitting}
            onClick={() => {
              form.reset();
              setFailure(null);
              setOpen(false);
            }}
          >
            {t('weldhr.common.cancel')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
