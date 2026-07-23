
import { EmptyStateIllustration } from '@/components/entity-list';
import { Users } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function TeamInboxPage() {
  const { t } = useI18n();
  const ip = t.helpdesk.inboxPages;

  return (
    <div className="h-full flex-1 flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
      <EmptyStateIllustration>
        <Users className="h-16 w-16 text-muted-foreground/30" />
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.noTeamConversationTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">
        {ip.selectConversationDesc}
      </p>
    </div>
  );
}
