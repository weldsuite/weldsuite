/** Answer a reply from the mailbox it came to. Cmd/Ctrl+Enter sends. */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import { reachReplySchema } from '@weldsuite/app-api-client/schemas/reach';
import { useReplyToReachThread } from '@/hooks/queries/use-reach-inbox-queries';
import { ErrorBanner, errorMessage } from '@/app/weldreach/components/engage/kit';

type ReplyValues = z.infer<typeof reachReplySchema>;

export function ReplyComposer({
  threadKey,
  mailboxEmail,
}: Readonly<{ threadKey: string; mailboxEmail: string }>) {
  const t = useTranslations();
  const reply = useReplyToReachThread(threadKey);
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<ReplyValues>({
    resolver: zodResolver(reachReplySchema),
    defaultValues: { body: '' },
  });
  const body = form.watch('body');

  const send = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      await reply.mutateAsync(values.body);
      form.reset({ body: '' });
      toast.success(t('reachEngage.inbox.composer.sent'));
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.inbox.composer.failed')));
    }
  });

  return (
    <form onSubmit={send} className="space-y-2 border-t bg-background p-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
      <Textarea
        rows={4}
        placeholder={t('reachEngage.inbox.composer.placeholder')}
        aria-label={t('reachEngage.inbox.composer.label')}
        disabled={reply.isPending}
        {...form.register('body')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t('reachEngage.inbox.composer.hint', { mailbox: mailboxEmail })}
        </p>
        <Button type="submit" size="sm" disabled={reply.isPending || body.trim() === ''}>
          {reply.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-1.5 h-4 w-4" />
          )}
          {t('reachEngage.inbox.composer.send')}
          <kbd className="ml-2 hidden text-[10px] opacity-70 sm:inline">
            {t('reachEngage.inbox.composer.shortcut')}
          </kbd>
        </Button>
      </div>
    </form>
  );
}
