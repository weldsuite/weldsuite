
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  Clock,
  Calendar,
  Send,
  Trash,
  Loader2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { mailApi } from '../lib/api-client';
import { useScheduledEmails } from '@/hooks/queries/use-mail-queries';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n/provider';

interface ScheduledEmail {
  id: string;
  accountId: string;
  to: Array<{ email: string; name?: string }> | string[];
  subject: string;
  preview?: string;
  scheduledFor: string;
  sendStatus: string;
  createdAt: string;
}

export function ScheduledClient() {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: t.mail.scheduled.title }
  ]);

  const { data, isLoading } = useScheduledEmails();
  const qc = useQueryClient();

  const scheduledEmails: ScheduledEmail[] = (data?.data || []) as ScheduledEmail[];

  const handleSendNow = async (id: string) => {
    try {
      const result = await mailApi.scheduled.sendNow(id);
      if (result.success) {
        toast.success(t.mail.scheduled.emailSentImmediately);
        qc.invalidateQueries({ queryKey: ['mail'] });
      } else {
        toast.error(result.error || t.mail.scheduled.failedToSend);
      }
    } catch {
      toast.error(t.mail.scheduled.failedToSend);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      const result = await mailApi.scheduled.cancel(id);
      if (result.success) {
        toast.success(t.mail.scheduled.scheduledEmailCancelled);
        qc.invalidateQueries({ queryKey: ['mail'] });
      } else {
        toast.error(result.error || t.mail.scheduled.failedToCancel);
      }
    } catch {
      toast.error(t.mail.scheduled.failedToCancelScheduled);
    }
  };

  const getRecipients = (to: ScheduledEmail['to']): string => {
    if (!to || !Array.isArray(to)) return t.mail.shared.unknown;
    return to.map((t) => (typeof t === 'string' ? t : t.email)).join(', ');
  };

  const getStatusColor = (scheduledFor: string) => {
    const hoursUntil = (new Date(scheduledFor).getTime() - new Date().getTime()) / (1000 * 60 * 60);
    if (hoursUntil < 1) return 'text-red-500 dark:text-red-400';
    if (hoursUntil < 24) return 'text-yellow-500 dark:text-yellow-400';
    return 'text-green-500 dark:text-green-400';
  };

  const upcomingToday = scheduledEmails.filter(email => {
    return new Date(email.scheduledFor).toDateString() === new Date().toDateString();
  });

  const upcomingLater = scheduledEmails.filter(email => {
    return new Date(email.scheduledFor).toDateString() !== new Date().toDateString();
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  const renderEmailCard = (email: ScheduledEmail, showDate: boolean) => (
    <Card key={email.id}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 flex-1">
            <Avatar className="h-8 w-8">
              <AvatarFallback>
                <Send className="h-4 w-4" />
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <p className="font-medium">{email.subject || t.mail.shared.noSubject}</p>
              <p className="text-sm text-muted-foreground mb-2">
                To: {getRecipients(email.to)}
              </p>
              {email.preview && (
                <p className="text-sm text-muted-foreground line-clamp-1">
                  {email.preview}
                </p>
              )}
              <div className="flex items-center gap-4 mt-3">
                {showDate && (
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    <span>{format(new Date(email.scheduledFor), 'PPP')}</span>
                  </div>
                )}
                <div className={cn("flex items-center gap-1 text-sm", getStatusColor(email.scheduledFor))}>
                  <Clock className="h-3 w-3" />
                  <span>{format(new Date(email.scheduledFor), 'h:mm a')}</span>
                  <span className="text-muted-foreground">
                    ({formatDistanceToNow(new Date(email.scheduledFor), { addSuffix: true })})
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleSendNow(email.id)}
              title={t.mail.scheduled.sendNow}
            >
              <Send className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleCancel(email.id)}
              title={t.mail.scheduled.cancel}
            >
              <Trash className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Clock className="h-6 w-6 text-primary" />
          {t.mail.scheduled.scheduledEmails}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t.mail.scheduled.scheduledEmailsDescription}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t.mail.scheduled.totalScheduled}</p>
                <p className="text-2xl font-bold">{scheduledEmails.length}</p>
              </div>
              <Send className="h-8 w-8 text-primary opacity-20" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t.mail.scheduled.today}</p>
                <p className="text-2xl font-bold">{upcomingToday.length}</p>
              </div>
              <Calendar className="h-8 w-8 text-yellow-500 dark:text-yellow-400 opacity-20" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Today's Scheduled */}
      {upcomingToday.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">{t.mail.scheduled.sendingToday}</h2>
          <div className="space-y-3">
            {upcomingToday.map((email) => renderEmailCard(email, false))}
          </div>
        </div>
      )}

      {/* Upcoming Later */}
      {upcomingLater.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">{t.mail.scheduled.upcoming}</h2>
          <div className="space-y-3">
            {upcomingLater.map((email) => renderEmailCard(email, true))}
          </div>
        </div>
      )}

      {scheduledEmails.length === 0 && (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center text-muted-foreground">
            <Clock className="h-12 w-12 mb-4" />
            <p className="text-lg font-medium">{t.mail.scheduled.noScheduledEmails}</p>
            <p className="text-sm mt-2">{t.mail.scheduled.noScheduledEmailsDescription}</p>
          </div>
        </Card>
      )}
    </div>
  );
}
