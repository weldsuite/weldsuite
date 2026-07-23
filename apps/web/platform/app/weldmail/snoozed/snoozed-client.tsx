
import { useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  Clock,
  Calendar,
  Bell,
  BellOff,
  Mail,
  ChevronRight,
  MoreVertical
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { format, formatDistanceToNow, isToday, isTomorrow } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface SnoozedEmail {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  preview: string;
  originalDate: Date;
  snoozedUntil: Date;
  labels: string[];
  isRead: boolean;
}

interface SnoozedClientProps {
  initialEmails: SnoozedEmail[];
}

export function SnoozedClient({ initialEmails }: SnoozedClientProps) {
  const { t } = useI18n();

  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: t.mail.snoozed.title }
  ]);

  const [snoozedEmails] = useState(initialEmails);

  const handleUnsnooze = (id: string) => {
    toast.success(t.mail.snoozed.emailMovedBackToInbox);
  };

  const handleResnooze = (id: string, hours: number) => {
    toast.success(t.mail.snoozed.emailSnoozedForHours.replace('{hours}', String(hours)));
  };

  const formatSnoozedTime = (date: Date) => {
    if (isToday(date)) {
      return t.mail.snoozed.todayAt.replace('{time}', format(date, 'h:mm a'));
    } else if (isTomorrow(date)) {
      return t.mail.snoozed.tomorrowAt.replace('{time}', format(date, 'h:mm a'));
    } else {
      return format(date, 'PPP \' at \' h:mm a');
    }
  };

  const getSnoozedColor = (snoozedUntil: Date) => {
    const hoursUntil = (snoozedUntil.getTime() - new Date().getTime()) / (1000 * 60 * 60);
    if (hoursUntil < 6) return 'text-red-500 dark:text-red-400';
    if (hoursUntil < 24) return 'text-yellow-500 dark:text-yellow-400';
    return 'text-green-500 dark:text-green-400';
  };

  const getLabelColor = (label: string) => {
    switch (label.toLowerCase()) {
      case 'work': return 'bg-blue-500 dark:bg-blue-600';
      case 'important': return 'bg-red-500 dark:bg-red-600';
      case 'finance': return 'bg-purple-500 dark:bg-purple-600';
      case 'travel': return 'bg-orange-500 dark:bg-orange-600';
      case 'newsletter': return 'bg-gray-500 dark:bg-border';
      default: return 'bg-gray-500 dark:bg-border';
    }
  };

  const snoozedToday = snoozedEmails.filter(email => isToday(email.snoozedUntil));
  const snoozedLater = snoozedEmails.filter(email => !isToday(email.snoozedUntil));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Clock className="h-6 w-6 text-primary" />
          {t.mail.snoozed.snoozedEmails}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t.mail.snoozed.snoozedEmailsDescription}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t.mail.snoozed.totalSnoozed}</p>
                <p className="text-2xl font-bold">{snoozedEmails.length}</p>
              </div>
              <Bell className="h-8 w-8 text-primary opacity-20" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t.mail.snoozed.wakingToday}</p>
                <p className="text-2xl font-bold">{snoozedToday.length}</p>
              </div>
              <Calendar className="h-8 w-8 text-yellow-500 dark:text-yellow-400 opacity-20" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{t.mail.snoozed.later}</p>
                <p className="text-2xl font-bold">{snoozedLater.length}</p>
              </div>
              <Clock className="h-8 w-8 text-green-500 dark:text-green-400 opacity-20" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Waking Today */}
      {snoozedToday.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">{t.mail.snoozed.wakingToday}</h2>
          <div className="space-y-3">
            {snoozedToday.map((email) => (
              <Card key={email.id} className="hover:bg-accent transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>{email.fromName[0]}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={cn(
                            "text-sm font-medium",
                            !email.isRead && "font-semibold"
                          )}>
                            {email.fromName}
                          </span>
                          {email.labels.map((label) => (
                            <div
                              key={label}
                              className={cn(
                                "h-2 w-2 rounded-full",
                                getLabelColor(label)
                              )}
                            />
                          ))}
                        </div>
                        <p className={cn(
                          "text-sm",
                          !email.isRead && "font-semibold"
                        )}>
                          {email.subject}
                        </p>
                        <p className="text-sm text-muted-foreground line-clamp-1 mt-1">
                          {email.preview}
                        </p>
                        <div className="flex items-center gap-4 mt-3">
                          <div className={cn(
                            "flex items-center gap-1 text-sm",
                            getSnoozedColor(email.snoozedUntil)
                          )}>
                            <Bell className="h-3 w-3" />
                            <span>{t.mail.snoozed.wakesIn.replace('{time}', formatDistanceToNow(email.snoozedUntil, { addSuffix: true }))}</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {t.mail.snoozed.originallyFrom.replace('{time}', formatDistanceToNow(email.originalDate, { addSuffix: true }))}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleUnsnooze(email.id)}
                      >
                        <BellOff className="h-4 w-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 1)}>
                            {t.mail.snoozed.snoozeFor1Hour}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 4)}>
                            {t.mail.snoozed.snoozeFor4Hours}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 24)}>
                            {t.mail.snoozed.snoozeUntilTomorrow}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 168)}>
                            {t.mail.snoozed.snoozeFor1Week}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Snoozed for Later */}
      {snoozedLater.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">{t.mail.snoozed.later}</h2>
          <div className="space-y-3">
            {snoozedLater.map((email) => (
              <Card key={email.id} className="hover:bg-accent transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>{email.fromName[0]}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={cn(
                            "text-sm font-medium",
                            !email.isRead && "font-semibold"
                          )}>
                            {email.fromName}
                          </span>
                          {email.labels.map((label) => (
                            <div
                              key={label}
                              className={cn(
                                "h-2 w-2 rounded-full",
                                getLabelColor(label)
                              )}
                            />
                          ))}
                        </div>
                        <p className={cn(
                          "text-sm",
                          !email.isRead && "font-semibold"
                        )}>
                          {email.subject}
                        </p>
                        <p className="text-sm text-muted-foreground line-clamp-1 mt-1">
                          {email.preview}
                        </p>
                        <div className="flex items-center gap-4 mt-3">
                          <div className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Bell className="h-3 w-3" />
                            <span>{t.mail.snoozed.wakesIn.replace('{time}', formatSnoozedTime(email.snoozedUntil))}</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {t.mail.snoozed.originallyFrom.replace('{time}', formatDistanceToNow(email.originalDate, { addSuffix: true }))}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleUnsnooze(email.id)}
                      >
                        <BellOff className="h-4 w-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 1)}>
                            {t.mail.snoozed.snoozeFor1Hour}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 4)}>
                            {t.mail.snoozed.snoozeFor4Hours}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 24)}>
                            {t.mail.snoozed.snoozeUntilTomorrow}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResnooze(email.id, 168)}>
                            {t.mail.snoozed.snoozeFor1Week}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {snoozedEmails.length === 0 && (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center text-muted-foreground">
            <Bell className="h-12 w-12 mb-4" />
            <p className="text-lg font-medium">{t.mail.snoozed.noSnoozedEmails}</p>
            <p className="text-sm mt-2">{t.mail.snoozed.noSnoozedEmailsDescription}</p>
          </div>
        </Card>
      )}
    </div>
  );
}
