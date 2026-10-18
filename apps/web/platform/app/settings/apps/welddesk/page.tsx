import { ArrowUpRight, BookOpen, Info, Mail, MessagesSquare, type LucideIcon } from 'lucide-react';
import { Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';

interface DeskSettingsLink {
  id: string;
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

export default function HelpdeskSettingsPage() {
  const ts = getTranslations('settings');
  const td = ts.welddesk;

  // These settings live in the WeldDesk app, not here. Each row says so and
  // links out, rather than pretending to be a settings screen.
  const links: DeskSettingsLink[] = [
    {
      id: 'chat-widget',
      href: '/welddesk/chat-widget',
      icon: MessagesSquare,
      title: td.chatWidgetTitle,
      description: td.chatWidgetDescription,
    },
    {
      id: 'email',
      href: '/welddesk/email',
      icon: Mail,
      title: td.emailTitle,
      description: td.emailDescription,
    },
    {
      id: 'help-center',
      href: '/welddesk/help-center',
      icon: BookOpen,
      title: td.helpCenterTitle,
      description: td.helpCenterDescription,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{td.title}</h1>
        <p className="text-muted-foreground">{td.description}</p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0">{td.leavingNotice}</p>
      </div>

      <ul className="divide-y rounded-lg border">
        {links.map((link) => (
          <li
            key={link.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <link.icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-medium">{link.title}</p>
                <p className="text-sm text-muted-foreground">{link.description}</p>
              </div>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0 self-start sm:self-center">
              <Link href={link.href} aria-label={`${td.openInWeldDesk}: ${link.title}`}>
                {td.openInWeldDesk}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
