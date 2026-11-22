/** Acknowledging an evaluation or coaching session: a dialog with an optional comment for HR. */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@weldsuite/ui/components/form';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useMyHrAcknowledgeCoaching, useMyHrAcknowledgeEvaluation } from '@/hooks/queries/use-weldhr-queries';
import { errorMessage } from '../../components/shared';

function buildSchema(maxMessage: string) {
  return z.object({ comment: z.string().max(5000, maxMessage) });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

export type AcknowledgeTarget = { kind: 'evaluation' | 'coaching'; id: string };

export function AcknowledgeDialog({ target, onClose }: Readonly<{ target: AcknowledgeTarget; onClose: () => void }>) {
  const t = useTranslations();
  const acknowledgeEvaluation = useMyHrAcknowledgeEvaluation();
  const acknowledgeCoaching = useMyHrAcknowledgeCoaching();
  const [failure, setFailure] = useState<string | null>(null);
  const schema = useMemo(() => buildSchema(t('weldhr.me.reviews.commentTooLong')), [t]);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { comment: '' } });
  const { isSubmitting } = form.formState;

  async function onSubmit(values: FormValues) {
    setFailure(null);
    const input = { id: target.id, comment: values.comment.trim() || null };
    try {
      if (target.kind === 'evaluation') await acknowledgeEvaluation.mutateAsync(input);
      else await acknowledgeCoaching.mutateAsync(input);
      toast.success(t('weldhr.me.reviews.acknowledgedToast'));
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.reviews.acknowledgeFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="mb-2">
          <DialogTitle>
            {target.kind === 'evaluation'
              ? t('weldhr.me.reviews.evaluations.acknowledgeTitle')
              : t('weldhr.me.reviews.coaching.acknowledgeTitle')}
          </DialogTitle>
          <DialogDescription>{t('weldhr.me.reviews.acknowledgeDescription')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form id="my-hr-acknowledge" onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
            <FormField
              control={form.control}
              name="comment"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Textarea rows={3} placeholder={t('weldhr.me.reviews.commentPlaceholder')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={isSubmitting} onClick={onClose}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="submit" form="my-hr-acknowledge" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.me.reviews.acknowledge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
