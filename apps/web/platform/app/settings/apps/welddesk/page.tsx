import { BookOpen, Bot, ChevronRight, Mail, MessagesSquare, Phone, Shuffle, Tags, type LucideIcon } from 'lucide-react';
import { Link } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';

interface DeskSettingsLink {
  id: string;
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

interface DeskSettingsSection {
  id: string;
  title: string;
  links: DeskSettingsLink[];
}

// Each WeldDesk settings page lives under this one: /settings/apps/welddesk/<id>.
function deskLink(id: string, icon: LucideIcon, title: string, description: string): DeskSettingsLink {
  return { id, href: `/settings/apps/welddesk/${id}`, icon, title, description };
}

export default function HelpdeskSettingsPage() {
  const ts = getTranslations('settings');
  const td = ts.welddesk;

  // Grouped the way the settings menu lists them.
  const sections: DeskSettingsSection[] = [
    {
      id: 'channels',
      title: td.sections.channels,
      links: [
        deskLink('chat-widget', MessagesSquare, td.chatWidgetTitle, td.chatWidgetDescription),
        deskLink('email', Mail, td.emailTitle, td.emailDescription),
        deskLink('phone', Phone, td.phoneTitle, td.phoneDescription),
        deskLink('help-center', BookOpen, td.helpCenterTitle, td.helpCenterDescription),
      ],
    },
    {
      id: 'ai',
      title: td.sections.ai,
      links: [deskLink('voice-agents', Bot, td.voiceAgentsTitle, td.voiceAgentsDescription)],
    },
    {
      id: 'tickets',
      title: td.sections.ticketsRouting,
      links: [
        deskLink('ticket-types', Tags, td.ticketTypesTitle, td.ticketTypesDescription),
        deskLink('assignment', Shuffle, td.assignmentTitle, td.assignmentDescription),
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{td.title}</h1>
        <p className="text-muted-foreground">{td.description}</p>
      </div>

      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`welddesk-settings-${section.id}`} className="space-y-2">
          <h2 id={`welddesk-settings-${section.id}`} className="text-sm font-medium text-muted-foreground">
            {section.title}
          </h2>
          <ul className="divide-y rounded-lg border">
            {section.links.map((link) => (
              <li key={link.id}>
                <Link href={link.href} className="flex items-center gap-3 p-4 transition-colors hover:bg-muted/50">
                  <link.icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{link.title}</span>
                    <span className="block text-sm text-muted-foreground">{link.description}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
