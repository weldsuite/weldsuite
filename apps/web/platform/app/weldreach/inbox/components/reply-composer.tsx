/**
 * Answer a reply from the mailbox it came to, in a box above the newest message
 * as in WeldMail. Cmd/Ctrl+Enter sends; the box closes once the reply is sent.
 */

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
import { errorMessage } from '@/app/weldreach/components/engage/kit';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';

type ReplyValues = z.infer<typeof reachReplySchema>;

export function ReplyComposer({
  threadKey,
  mailboxEmail,
  onCancel,
  onSent,
}: Readonly<{ threadKey: string; mailboxEmail: string; onCancel: () => void; onSent: () => void }>) {
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
      onSent();
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.inbox.composer.failed')));
    }
  });

  return (
    <form onSubmit={send} className="mx-3 mt-3 space-y-2 rounded-lg border border-border bg-background p-3 md:mx-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
      <Textarea
        rows={4}
        autoFocus
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
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={reply.isPending}>
            {t('reachEngage.common.cancel')}
          </Button>
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
      </div>
    </form>
  );
}
